// The `schema_updated` notice through the service (04-contract §13, §2; 04-contract-types §7):
// "last read" is taken as the `sv` fallback takes it, under the task the surface gives and counting
// the caller's own writes; a write is placed by the slot it wrote, also when it used an earlier
// version's names. Fictional names.

import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
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
  localServedTenant,
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
const root = mkdtempSync(join(tmpdir(), "saveslot-schema-notices-"));
const home = join(root, "home");
const NOW = "2026-11-16T12:00:00.000Z";
let t: LocalTenant;
let credentials: Credentials;
let cursors: CursorKeys;
let user: Principal;
let agent: Principal;
let version = 1;

// biome-ignore lint/suspicious/noExplicitAny: results as the contract gives them
type Any = any;

async function principal(token: string): Promise<Principal> {
  const p = await authenticate({ credentials, tenant: t, authorization: `Bearer ${token}` });
  if (!("kind" in p)) throw new Error(p.reason);
  return p;
}

/** Calls `operation` as `who`, under the surface's `task` when given. */
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
      tenant: localServedTenant(t, credentials),
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

const schemaNotices = (r: Any) =>
  ((r.notices ?? []) as Any[]).filter((n) => n.code === "schema_updated");
const PAIRS = {
  name: "pairs",
  kind: "base",
  description: "two texts",
  time: { type: "none" },
  fields: [
    { name: "a", type: "text", description: "first" },
    { name: "b", type: "text", description: "second" },
  ],
};
/** The next version of `ledger`, by the user: `pairs` as given, confirmed when it waits. */
async function next(table: Record<string, unknown>): Promise<void> {
  const d = await call(user, "schema_draft", {
    document: {
      slot: "ledger",
      base_version: version,
      timezone: "Asia/Shanghai",
      tables: [
        {
          ...PAIRS,
          id: "t1",
          fields: [
            { ...PAIRS.fields[0], id: "f1" },
            { ...PAIRS.fields[1], id: "f2" },
          ],
          ...table,
        },
      ],
    },
  });
  if (d.outcome === "pending")
    await call(user, "resolve", { id: d.item.id, decision: "confirm", item_ver: d.item.item_ver });
  version++;
  const c = await call(user, "catalog", { level: "schema", slot: "ledger" });
  expect(c.sv).toBe(version);
}

beforeAll(async () => {
  await initLocalHome({ home, backend: testBackend(), lock: osFileLock, now: NOW });
  const r = await openLocalTenant({ home, backend: testBackend() });
  if (!r.ok) throw new Error(r.failure);
  t = r.tenant;
  credentials = await Credentials.load(home);
  cursors = await CursorKeys.open(home);
  user = await principal(readFileSync(sessionFile(home), "utf8").trim());
  await call(user, "schema_draft", {
    document: { slot: "ledger", base_version: null, timezone: "Asia/Shanghai", tables: [PAIRS] },
  });
  agent = await principal((await call(user, "connections.issue", { name: "agent" })).token);
}, T);
afterAll(async () => {
  await closeLocalTenant(t);
  await rm(root, { recursive: true, force: true });
}, T);

describe("schema_updated through the service", () => {
  it(
    "under a task: a write taking sv by fallback is told what changed since that task's read",
    async () => {
      await call(agent, "catalog", { level: "schema", slot: "ledger" }, "t");
      await next({ description: "pairs of texts" });
      const w = await call(
        agent,
        "write",
        { ops: [{ intent: "insert", table: "ledger.pairs", set: { a: "A" } }] },
        "t",
      );
      expect(w.sv).toBe(1);
      expect(schemaNotices(w)).toEqual([
        { code: "schema_updated", slot: "ledger", from: 1, to: 2, changed: ["pairs"] },
      ]);
    },
    T,
  );

  it(
    "under a task: this call's read is the task's, not a read without one",
    async () => {
      // Read without a task at the version now, then the slot moves on.
      await call(agent, "catalog", { level: "schema", slot: "ledger" });
      await next({ description: "pairs of two texts" });
      // Under t, this read is of the version now: nothing behind.
      const r = await call(agent, "catalog", { level: "schema", slot: "ledger" }, "t");
      expect(r.sv).toBe(version);
      expect(schemaNotices(r)).toEqual([]);
    },
    T,
  );

  it(
    "a write by an earlier version's table name is told too (placed by the slot it wrote)",
    async () => {
      const at = version;
      await next({ name: "couples" });
      const w = await call(
        agent,
        "write",
        { sv: at, ops: [{ intent: "insert", table: "ledger.pairs", set: { b: "B" } }] },
        "t",
      );
      expect(w.sv).toBe(at);
      expect(schemaNotices(w)).toEqual([
        { code: "schema_updated", slot: "ledger", from: at, to: at + 1, changed: ["couples"] },
      ]);
    },
    T,
  );

  it(
    "the caller's own write counts as having read its version, as for the fallback",
    async () => {
      // Under task w nothing was read: the write's own sv is what it last had.
      const at = version;
      await call(
        agent,
        "write",
        { sv: at, ops: [{ intent: "insert", table: "ledger.couples", set: { a: "C" } }] },
        "w",
      );
      await next({ name: "couples", description: "couples of texts" });
      const w = await call(
        agent,
        "write",
        { sv: at, ops: [{ intent: "insert", table: "ledger.couples", set: { a: "D" } }] },
        "w",
      );
      expect(schemaNotices(w)).toEqual([
        { code: "schema_updated", slot: "ledger", from: at, to: at + 1, changed: ["couples"] },
      ]);
    },
    T,
  );
});
