// The `pending_items` notice through a running service (04-contract §13; 04-contract-types §7):
// which slots a call involves, the visible range, the order and the cut at three, a slot without
// items, `pending`'s own results, and a replay computed now. Fictional names.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalHome, sessionFile } from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import type { Driver } from "./contract-suite.fixture.ts";
import { httpDriver } from "./http-driver.fixture.ts";
import { type RunningService, runService } from "./service.ts";

const T = 60_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-notices-"));
const home = join(root, "home");
let service: RunningService;
let session = "";
const driver: Driver = httpDriver(() => home);

// biome-ignore lint/suspicious/noExplicitAny: results as the contract gives them
type Any = any;
const ok = async (p: ReturnType<Driver>): Promise<Any> => {
  const o = await p;
  if (!("result" in o)) throw new Error(`refused: ${JSON.stringify(o.error)}`);
  return o.result;
};
const notices = (r: Any) =>
  ((r.notices ?? []) as Any[])
    .filter((n) => n.code === "pending_items")
    .map((n) => [n.slot, n.count]);

const SLOTS = ["a", "b", "c", "d", "e"];
const docOf = (slot: string) => ({
  slot,
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: `notes_${slot}`,
      kind: "base",
      description: "notes",
      time: { type: "none" },
      fields: [{ name: "b", type: "text", required: true, description: "b" }],
    },
  ],
});
const write = (credential: string, slot: string, op: Record<string, unknown>, key?: string) =>
  driver(
    credential,
    "write",
    { sv: 1, ops: [{ table: `${slot}.notes_${slot}`, ...op }] },
    key !== undefined ? { idempotencyKey: key } : {},
  );

let writer = "";
let made = 0;
/**
 * One conflict item in `slot`: two updates from the same seen version. Its ID. The values differ
 * from call to call: the same request again within the window would be a resend.
 */
async function conflictIn(slot: string): Promise<string> {
  const n = ++made;
  const e = await ok(write(session, slot, { intent: "insert", set: { b: `b0-${n}` } }));
  const row = e.ops[0].target.row as string;
  const ver = e.ops[0].ver as string;
  await ok(write(session, slot, { row, intent: "update", ver, set: { b: `b1-${n}` } }));
  const c = await ok(write(writer, slot, { row, intent: "update", ver, set: { b: `b2-${n}` } }));
  return (c.pending as Any[]).find((x) => x.type === "conflict").id as string;
}

const items = new Map<string, string>();
beforeAll(async () => {
  await initLocalHome({
    home,
    backend: testBackend(),
    lock: osFileLock,
    now: new Date().toISOString(),
  });
  session = readFileSync(sessionFile(home), "utf8").trim();
  service = await runService({ home, version: "t", signals: false, log: () => {} });
  for (const s of SLOTS) await ok(driver(session, "schema_draft", { document: docOf(s) }));
  writer = (await ok(driver(session, "connections.issue", { name: "writer" }))).token as string;
  // Opened in this order: c, a, b, d (oldest first); e has none.
  for (const s of ["c", "a", "b", "d"]) items.set(s, await conflictIn(s));
}, T * 2);
afterAll(async () => {
  await service?.stop();
  rmSync(root, { recursive: true, force: true });
}, T);

describe("pending_items notices", () => {
  it(
    "the catalog's list: one notice a slot with items, oldest first, three at most; none for a slot without",
    async () => {
      const r = await ok(driver(session, "catalog", {}));
      expect(notices(r)).toEqual([
        ["c", 1],
        ["a", 1],
        ["b", 1],
      ]);
      const at = (r.notices as Any[]).map((n) => n.oldest_opened_at as string);
      expect([...at].sort()).toEqual(at);
    },
    T,
  );

  it(
    "a call on one slot: that slot only; a slot without items gives none",
    async () => {
      expect(notices(await ok(driver(session, "query", { table: "d.notes_d" })))).toEqual([
        ["d", 1],
      ]);
      expect(await ok(driver(session, "query", { table: "e.notes_e" }))).not.toHaveProperty(
        "notices",
      );
    },
    T,
  );

  it(
    "a connection sees notices of its range only",
    async () => {
      const only = await ok(driver(session, "connections.issue", { name: "only-d", slots: ["d"] }));
      const r = await ok(driver(only.token as string, "catalog", {}));
      expect(notices(r)).toEqual([["d", 1]]);
    },
    T,
  );

  it(
    "pending's own results carry no pending_items",
    async () => {
      const list = await ok(driver(session, "pending", {}));
      expect(list.items.length).toBeGreaterThan(0);
      expect(notices(list)).toEqual([]);
      const detail = await ok(driver(session, "pending", { id: items.get("a") }));
      expect(notices(detail)).toEqual([]);
    },
    T,
  );

  it(
    "a replayed write's notices are as of now: an item resolved in between is not counted",
    async () => {
      // A second item in b, then a write to b sent twice with one key, an item resolved between.
      const second = await conflictIn("b");
      const first = await ok(
        write(session, "b", { intent: "insert", set: { b: "x" } }, "notice-k"),
      );
      expect(notices(first)).toEqual([["b", 2]]);
      const d = await ok(driver(session, "pending", { id: second }));
      await ok(
        driver(session, "resolve", {
          id: second,
          decision: "keep_effective",
          item_ver: d.item_ver,
        }),
      );
      const again = await ok(
        write(session, "b", { intent: "insert", set: { b: "x" } }, "notice-k"),
      );
      expect(again.replayed).toBe(true);
      expect(again.seq).toBe(first.seq);
      expect(notices(again)).toEqual([["b", 1]]);
    },
    T,
  );
});
