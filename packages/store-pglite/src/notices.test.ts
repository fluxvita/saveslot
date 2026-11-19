// The `pending_items` notices the kernel computes for the service (04-contract §13): only within
// the caller's visible range, whatever the call's references name. Fictional IDs and names.

import {
  createOpsContext,
  createTenant,
  pendingItemsNotices,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"9".repeat(26)}`;
const USER = `u_${"2".repeat(26)}`;
const OTHER = `ci_${"6".repeat(26)}`;

let s: ReusableStore;
let minute = 0;
const ctxOf = (actor: string) =>
  createOpsContext({
    tenant: TENANT,
    actor,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T04:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  } as never);
// biome-ignore lint/suspicious/noExplicitAny: receipts as the kernel gives them
type Any = any;
const ids = new Map<string, string>();

beforeAll(async () => {
  s = await openReusable("saveslot-notices-");
  await createTenant(s.store, ctxOf(USER));
  for (const slot of ["a", "b"]) {
    const d = (await schemaDraft(s.store, ctxOf(USER), {
      document: {
        slot,
        base_version: null,
        timezone: "Asia/Shanghai",
        tables: [
          {
            name: "notes",
            kind: "base",
            description: "notes",
            time: { type: "none" },
            fields: [{ name: "b", type: "text", required: true, description: "b" }],
          },
        ],
      },
    } as never)) as Any;
    ids.set(slot, d.slot_id);
    const put = (op: Record<string, unknown>, actor = USER) =>
      write(s.store, ctxOf(actor), {
        sv: 1,
        ops: [{ table: `${slot}.notes`, ...op }],
      } as never) as Promise<Any>;
    const e = await put({ intent: "insert", set: { b: "b0" } });
    const row = e.ops[0].target.row;
    const ver = e.ops[0].ver;
    await put({ row, intent: "update", ver, set: { b: "b1" } });
    await put({ row, intent: "update", ver, set: { b: "b2" } }, OTHER);
  }
}, T);
afterAll(async () => {
  await s?.close();
}, T);

describe("pendingItemsNotices", () => {
  it(
    "a slot out of the caller's range gives no notice, though the references name it",
    async () => {
      const all = await pendingItemsNotices(s.store, { kind: "all" }, { slots: ["a", "b"] });
      expect(all.map((n) => [n.slot, n.count])).toEqual([
        ["a", 1],
        ["b", 1],
      ]);
      const onlyA = await pendingItemsNotices(
        s.store,
        { kind: "scoped", slots: [{ slot: ids.get("a") as never }] },
        { slots: ["a", "b"], tables: ["b.notes"] },
      );
      expect(onlyA.map((n) => [n.slot, n.count])).toEqual([["a", 1]]);
    },
    T,
  );
});
