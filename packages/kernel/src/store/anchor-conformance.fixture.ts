// What every anchor store implementation must do (docs/zh-CN/spec/02-architecture.md §8 "锚点存储";
// the port in ./anchor.ts), as a reusable suite: call `anchorStoreConformance` from a test file
// with a factory for the implementation under test. The file implementation runs it here; the
// control plane implementation of the service is meant to run it too.

import { describe, expect, it } from "vitest";
import type { AnchorStore, AnchorStoreErrorCode, DeletionEntry } from "./anchor.ts";

export interface AnchorStoreSubject {
  /** A store with nothing in it. */
  readonly store: AnchorStore;
  /** Another instance over the same storage, when the implementation persists: checks durability. */
  readonly reopen?: () => AnchorStore | Promise<AnchorStore>;
}

const TENANT = `tn_${"1".repeat(26)}`;
const OTHER = `tn_${"2".repeat(26)}`;

/** A deletion entry; `n` makes the ID and seqs distinct. */
export function deletionEntry(n: number, patch: Partial<DeletionEntry> = {}): DeletionEntry {
  return {
    deletion: `pi_${String(n).padStart(16, "0")}`,
    kind: "privacy",
    state: "pending",
    dueAt: "2026-11-11T04:00:00.000Z",
    confirmedSeq: 100 + n,
    sources: [10 + n],
    positions: [{ seq: 20 + n, path: "text" }],
    ...patch,
  };
}

/** Expects the promise to reject with an AnchorStoreError of `code`. */
async function refuses(p: Promise<unknown>, code: AnchorStoreErrorCode): Promise<void> {
  await expect(p).rejects.toMatchObject({ name: "AnchorStoreError", code });
}

export function anchorStoreConformance(
  name: string,
  make: () => AnchorStoreSubject | Promise<AnchorStoreSubject>,
): void {
  describe(`anchor store conformance: ${name}`, () => {
    it("reads the empty anchor for a tenant never written", async () => {
      const { store } = await make();
      expect(await store.read(TENANT)).toEqual({ deletions: [], highWater: 0, restoreCount: 0 });
    });

    describe("putDeletion and removeDeletion", () => {
      it("adds entries in order and replaces an entry with the same ID as a whole", async () => {
        const { store } = await make();
        await store.putDeletion(TENANT, deletionEntry(1, { state: "intent" }));
        await store.putDeletion(TENANT, deletionEntry(2));
        const replaced = deletionEntry(1, { state: "executed", sources: [], positions: [] });
        await store.putDeletion(TENANT, replaced);
        expect((await store.read(TENANT)).deletions).toEqual([replaced, deletionEntry(2)]);
      });

      it("keeps every state and kind of the port", async () => {
        const { store } = await make();
        const states = ["intent", "pending", "cancelled", "executed"] as const;
        for (const [i, state] of states.entries())
          await store.putDeletion(TENANT, deletionEntry(i, { state }));
        expect((await store.read(TENANT)).deletions.map((e) => e.state)).toEqual(states);
      });

      it("removes an entry, and does nothing for an ID not there", async () => {
        const { store } = await make();
        await store.putDeletion(TENANT, deletionEntry(1));
        await store.putDeletion(TENANT, deletionEntry(2));
        await store.removeDeletion(TENANT, deletionEntry(1).deletion);
        await store.removeDeletion(TENANT, deletionEntry(9).deletion);
        expect((await store.read(TENANT)).deletions).toEqual([deletionEntry(2)]);
      });

      it.each<[string, Partial<Record<keyof DeletionEntry, unknown>> | "extra"]>([
        ["an empty ID", { deletion: "" }],
        ["an unknown kind", { kind: "evidence" }],
        ["an unknown state", { state: "done" }],
        ["a due time not an instant", { dueAt: "2026-11-11" }],
        ["a confirmation seq of 0", { confirmedSeq: 0 }],
        ["a fractional seq", { confirmedSeq: 1.5 }],
        ["a source seq of 0", { sources: [0] }],
        ["a position without a path", { positions: [{ seq: 1, path: "" }] }],
        ["a position with an extra key", { positions: [{ seq: 1, path: "a", body: "x" }] }],
        ["an extra key", "extra"],
      ])("refuses an entry with %s and stores nothing", async (_, patch) => {
        const { store } = await make();
        const bad =
          patch === "extra"
            ? { ...deletionEntry(1), note: "x" }
            : { ...deletionEntry(1), ...patch };
        await refuses(store.putDeletion(TENANT, bad as DeletionEntry), "invalid_entry");
        expect((await store.read(TENANT)).deletions).toEqual([]);
      });

      it.each(["constructor", "__proto__", "toString"])(
        "takes %s as a tenant like any other",
        async (tenant) => {
          const { store } = await make();
          expect(await store.read(tenant)).toEqual({
            deletions: [],
            highWater: 0,
            restoreCount: 0,
          });
          await store.advanceHighWater(tenant, 5);
          await store.putDeletion(tenant, deletionEntry(1));
          expect(await store.read(tenant)).toEqual({
            deletions: [deletionEntry(1)],
            highWater: 5,
            restoreCount: 0,
          });
          expect(await store.read(TENANT)).toEqual({
            deletions: [],
            highWater: 0,
            restoreCount: 0,
          });
        },
      );

      it("refuses a tenant ID that is not one", async () => {
        const { store } = await make();
        for (const t of ["", "\ud800"]) {
          await refuses(store.read(t), "invalid_entry");
          await refuses(store.advanceHighWater(t, 1), "invalid_entry");
          await refuses(store.beginImport(t, "im_1"), "invalid_entry");
        }
      });

      it("keeps tenants apart", async () => {
        const { store } = await make();
        await store.putDeletion(TENANT, deletionEntry(1));
        await store.advanceHighWater(OTHER, 5);
        expect(await store.read(TENANT)).toEqual({
          deletions: [deletionEntry(1)],
          highWater: 0,
          restoreCount: 0,
        });
        expect(await store.read(OTHER)).toEqual({ deletions: [], highWater: 5, restoreCount: 0 });
      });

      it("returns copies: changing what was read or given changes nothing stored", async () => {
        const { store } = await make();
        const given = deletionEntry(1);
        await store.putDeletion(TENANT, given);
        (given.sources as number[]).push(99);
        const read = await store.read(TENANT);
        (read.deletions as DeletionEntry[]).pop();
        expect((await store.read(TENANT)).deletions).toEqual([deletionEntry(1)]);
      });

      it("applies concurrent writes one after another, losing none", async () => {
        const { store } = await make();
        await Promise.all(
          Array.from({ length: 20 }, (_, i) => store.putDeletion(TENANT, deletionEntry(i))),
        );
        const ids = (await store.read(TENANT)).deletions.map((e) => e.deletion).sort();
        expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => deletionEntry(i).deletion).sort());
      });
    });

    describe("advanceHighWater", () => {
      it("only increases", async () => {
        const { store } = await make();
        await store.advanceHighWater(TENANT, 10);
        await store.advanceHighWater(TENANT, 7);
        await store.advanceHighWater(TENANT, 10);
        expect((await store.read(TENANT)).highWater).toBe(10);
        await store.advanceHighWater(TENANT, 11);
        expect((await store.read(TENANT)).highWater).toBe(11);
      });

      it("refuses a value that is not a seq", async () => {
        const { store } = await make();
        await refuses(store.advanceHighWater(TENANT, -1), "invalid_entry");
        await refuses(store.advanceHighWater(TENANT, 1.5), "invalid_entry");
        expect((await store.read(TENANT)).highWater).toBe(0);
      });
    });

    describe("restore", () => {
      it("begins: sets the marker and adds one to the count", async () => {
        const { store } = await make();
        const a = await store.beginRestore(TENANT, "rs_1");
        expect(a).toEqual({
          deletions: [],
          highWater: 0,
          restoreCount: 1,
          restoreInProgress: "rs_1",
        });
        expect(await store.read(TENANT)).toEqual(a);
      });

      it("begins again while in progress: returns the anchor unchanged, whatever the ID", async () => {
        const { store } = await make();
        await store.beginRestore(TENANT, "rs_1");
        const again = await store.beginRestore(TENANT, "rs_2");
        expect(again).toEqual({
          deletions: [],
          highWater: 0,
          restoreCount: 1,
          restoreInProgress: "rs_1",
        });
        expect(await store.read(TENANT)).toEqual(again);
      });

      it("ends: clears the marker and never lowers the high water mark", async () => {
        const { store } = await make();
        await store.advanceHighWater(TENANT, 50);
        await store.beginRestore(TENANT, "rs_1");
        await store.endRestore(TENANT, "rs_1", 40);
        expect(await store.read(TENANT)).toEqual({ deletions: [], highWater: 50, restoreCount: 1 });
        await store.beginRestore(TENANT, "rs_2");
        await store.endRestore(TENANT, "rs_2", 60);
        expect(await store.read(TENANT)).toEqual({ deletions: [], highWater: 60, restoreCount: 2 });
      });

      it("refuses to end a restore not in progress", async () => {
        const { store } = await make();
        await refuses(store.endRestore(TENANT, "rs_1", 1), "not_in_progress");
        await store.beginRestore(TENANT, "rs_1");
        await refuses(store.endRestore(TENANT, "rs_2", 1), "not_in_progress");
        expect((await store.read(TENANT)).restoreInProgress).toBe("rs_1");
      });
    });

    describe("import", () => {
      it("begins on an empty anchor", async () => {
        const { store } = await make();
        await store.beginImport(TENANT, "im_1");
        expect(await store.read(TENANT)).toEqual({
          deletions: [],
          highWater: 0,
          restoreCount: 0,
          importInProgress: "im_1",
        });
      });

      it("begins with a high water mark: it is not part of the emptiness test", async () => {
        const { store } = await make();
        await store.advanceHighWater(TENANT, 1);
        await store.beginImport(TENANT, "im_1");
        expect((await store.read(TENANT)).importInProgress).toBe("im_1");
      });

      it.each<[string, (s: AnchorStore) => Promise<unknown>]>([
        ["a deletion entry", (s) => s.putDeletion(TENANT, deletionEntry(1))],
        [
          "a restore count",
          async (s) => {
            await s.beginRestore(TENANT, "rs_1");
            await s.endRestore(TENANT, "rs_1", 0);
          },
        ],
        ["a restore in progress", (s) => s.beginRestore(TENANT, "rs_1")],
        ["another import in progress", (s) => s.beginImport(TENANT, "im_0")],
        ["this import in progress", (s) => s.beginImport(TENANT, "im_1")],
      ])("refuses to begin on an anchor with %s, changing nothing", async (_, setUp) => {
        const { store } = await make();
        await setUp(store);
        const before = await store.read(TENANT);
        await refuses(store.beginImport(TENANT, "im_1"), "import_refused");
        expect(await store.read(TENANT)).toEqual(before);
      });

      it("ends: writes the entries, the high water mark and the count, clears the marker", async () => {
        const { store } = await make();
        await store.advanceHighWater(TENANT, 3);
        await store.beginImport(TENANT, "im_1");
        await store.endImport(TENANT, "im_1", {
          deletions: [deletionEntry(1), deletionEntry(2, { state: "intent" })],
          highWater: 80,
          restoreCount: 4,
        });
        expect(await store.read(TENANT)).toEqual({
          deletions: [deletionEntry(1), deletionEntry(2, { state: "intent" })],
          highWater: 80,
          restoreCount: 4,
        });
      });

      it("ends without lowering the high water mark", async () => {
        const { store } = await make();
        await store.advanceHighWater(TENANT, 90);
        await store.beginImport(TENANT, "im_1");
        await store.endImport(TENANT, "im_1", { deletions: [], highWater: 80, restoreCount: 1 });
        expect(await store.read(TENANT)).toEqual({ deletions: [], highWater: 90, restoreCount: 1 });
      });

      it("refuses to end an import not in progress", async () => {
        const { store } = await make();
        const r = { deletions: [], highWater: 1, restoreCount: 1 };
        await refuses(store.endImport(TENANT, "im_1", r), "not_in_progress");
        await store.beginImport(TENANT, "im_1");
        await refuses(store.endImport(TENANT, "im_2", r), "not_in_progress");
        expect(await store.read(TENANT)).toMatchObject({
          importInProgress: "im_1",
          restoreCount: 0,
        });
      });

      it("refuses to end with invalid entries, keeping the marker", async () => {
        const { store } = await make();
        await store.beginImport(TENANT, "im_1");
        const bad = [
          [deletionEntry(1), deletionEntry(1)],
          [deletionEntry(1, { state: "gone" as never })],
        ];
        for (const deletions of bad) {
          await refuses(
            store.endImport(TENANT, "im_1", { deletions, highWater: 1, restoreCount: 1 }),
            "invalid_entry",
          );
        }
        await refuses(
          store.endImport(TENANT, "im_1", { deletions: [], highWater: -1, restoreCount: 1 }),
          "invalid_entry",
        );
        await refuses(
          store.endImport(TENANT, "im_1", { deletions: [], highWater: 1, restoreCount: 0.5 }),
          "invalid_entry",
        );
        expect(await store.read(TENANT)).toEqual({
          deletions: [],
          highWater: 0,
          restoreCount: 0,
          importInProgress: "im_1",
        });
      });

      it("aborts: clears only the marker; nothing when none; refuses another import's", async () => {
        const { store } = await make();
        await store.abortImport(TENANT, "im_1");
        expect(await store.read(TENANT)).toEqual({ deletions: [], highWater: 0, restoreCount: 0 });
        await store.advanceHighWater(TENANT, 2);
        await store.beginImport(TENANT, "im_1");
        await refuses(store.abortImport(TENANT, "im_2"), "not_in_progress");
        await store.abortImport(TENANT, "im_1");
        await store.abortImport(TENANT, "im_1");
        expect(await store.read(TENANT)).toEqual({ deletions: [], highWater: 2, restoreCount: 0 });
      });
    });

    it("keeps everything for another instance over the same storage", async () => {
      const { store, reopen } = await make();
      if (reopen === undefined) return;
      await store.putDeletion(TENANT, deletionEntry(1));
      await store.advanceHighWater(TENANT, 7);
      await store.beginRestore(TENANT, "rs_1");
      await store.beginImport(OTHER, "im_1");
      const again = await reopen();
      expect(await again.read(TENANT)).toEqual({
        deletions: [deletionEntry(1)],
        highWater: 7,
        restoreCount: 1,
        restoreInProgress: "rs_1",
      });
      expect(await again.read(OTHER)).toMatchObject({ importInProgress: "im_1" });
    });
  });
}
