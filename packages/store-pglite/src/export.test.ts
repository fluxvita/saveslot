// The export file on PGlite (09-event-format §8; 04-contract-types §8.4 `export`): the manifest,
// the three states of a block, continuation, and what the reader of the file can check.
// Fictional IDs and data.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOperation,
  clearBlocks,
  ExportError,
  encode,
  exportBatch,
  exportStart,
  type NewOperation,
  writeExport,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

const USER = `u_${"1".repeat(26)}` as const;
const CONN = `ci_${"2".repeat(26)}` as const;
const SLOT = `sl_${"3".repeat(16)}` as const;
const ROW = `r_${"6".repeat(26)}` as const;
const TENANT = `tn_${"8".repeat(26)}`;
const DELETION = `pi_${"7".repeat(16)}` as const;
type Instant = NewOperation["now"];
const t = (hhmm: string) => `2026-11-10T${hhmm}:00.000Z` as Instant;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const canonicalize = (v: unknown) => encode(v as never).text;
const EXPORTED_AT = t("09:00");

const genesis: NewOperation = {
  actor: USER,
  now: t("04:00"),
  events: [
    {
      type: "tenant.genesis",
      node_id: `n_${"4".repeat(26)}`,
      blocks: {
        tenant: { tenant_id: TENANT, storage_format: 1, event_format: 1 },
        user: { principal: USER, kind: "user" },
        system: { principal: "system", kind: "system" },
      },
    },
  ],
};

const write = (now: Instant, value: string): NewOperation => ({
  actor: CONN,
  now,
  events: [
    {
      type: "write.head",
      slot: SLOT,
      blocks: {
        ctx: {
          now,
          today: "2026-11-10",
          ruleset_version: 1,
          policy_version: 1,
          literal_checker: "literal@1",
        },
        request: { ops: 1 },
        "ops/0/target": { table: "t1", row: ROW, intent: "create" },
        "ops/0/set/f2": value,
      },
    },
    {
      type: "source.recorded",
      slot: SLOT,
      blocks: { target: { kind: "api_call" }, request: { f2: value } },
    },
    {
      type: "write.base",
      slot: SLOT,
      blocks: {
        target: { table: "t1", row: ROW, intent: "create" },
        "fields/f2/0": { value, status: "applied" },
      },
    },
  ],
});

const tombstone = (now: Instant): NewOperation => ({
  actor: "system",
  now,
  events: [
    {
      type: "deletion.executed",
      slot: SLOT,
      trigger: "deletion_expiry",
      blocks: {
        target: { deletion: DELETION, confirmed_event: 8, reason: "expiry" },
        positions: [{ seq: 6, path: "request" }],
      },
    },
  ],
});

const confirmed = (now: Instant, deletion: string = DELETION): NewOperation => ({
  actor: CONN,
  now,
  events: [
    {
      type: "deletion.confirmed",
      slot: SLOT,
      blocks: {
        ctx: {
          now,
          today: "2026-11-10",
          ruleset_version: 1,
          policy_version: 1,
        },
        target: {
          deletion,
          kind: "privacy",
          due_at: t("23:00"),
          sources: [5],
          origin: "request",
        },
        positions: [{ seq: 6, path: "request" }],
      },
    },
  ],
});

const roots: string[] = [];
let store: PgliteTenantStore;
const T = 60_000;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "saveslot-export-"));
  roots.push(root);
  store = await testBackend().open({ kind: "pglite", dir: join(root, "tenant") }, { create: true });
  await store.write((tx) => appendOperation(tx, genesis)); // 1
  await store.write((tx) => appendOperation(tx, write(t("04:10"), "45"))); // 2–4
  await store.write((tx) => appendOperation(tx, write(t("04:20"), "50"))); // 5–7
}, T);

afterAll(async () => {
  await store?.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, 120_000);

async function exportLines(
  p: { afterSeq?: number; includePendingDeletion?: boolean } = {},
): Promise<string[]> {
  const lines: string[] = [];
  await store.read((tx) =>
    writeExport(tx, { ...p, exportedAt: EXPORTED_AT }, async (l) => {
      lines.push(l);
    }),
  );
  return lines;
}
interface Line {
  h: { seq: number; prev_hash: string };
  c?: Record<string, { v: unknown; sum: string }>;
  [k: string]: unknown;
}
const parse = (lines: string[]) => lines.map((l) => JSON.parse(l) as Line);

describe("the export file", () => {
  it(
    "is a manifest then every event, each line in JCS; headers chain and checksums hold for the reader",
    async () => {
      const lines = await exportLines();
      expect(lines.every((l) => l.endsWith("\n") && !l.slice(0, -1).includes("\n"))).toBe(true);
      expect(lines.every((l) => canonicalize(JSON.parse(l)) === l.slice(0, -1))).toBe(true);
      const [manifest, ...events] = parse(lines);
      expect(manifest).toEqual({
        saveslot_export: 1,
        tenant_id: TENANT,
        event_format: 1,
        restore_count: 0,
        upto: 7,
        events: 7,
        exported_at: EXPORTED_AT,
        pending_deletions: "placeholder",
      });
      expect(events.map((e) => e.h.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);

      // What a reader checks (09 §8): the header hash chain, and every present block's checksum.
      let prev = "0".repeat(64);
      for (const e of events) {
        expect(e.h.prev_hash).toBe(prev);
        prev = sha(canonicalize(e.h));
        for (const b of Object.values(e.c ?? {})) {
          expect(b.sum).toBe(sha(canonicalize(b.v)));
        }
      }
    },
    T,
  );

  it("a continuation holds the events after `after`, and says so", async () => {
    const [manifest, ...events] = parse(await exportLines({ afterSeq: 4 }));
    expect(manifest).toMatchObject({ after: 4, upto: 7, events: 3 });
    expect(events.map((e) => e.h.seq)).toEqual([5, 6, 7]);
    // Continuing from the end: no events, still a manifest.
    const [m2, ...none] = parse(await exportLines({ afterSeq: 7 }));
    expect(m2).toMatchObject({ after: 7, upto: 7, events: 0 });
    expect(none).toEqual([]);
  });

  it("refuses an `after_seq` beyond the end, and a negative one", async () => {
    for (const afterSeq of [8, -1, 1.5]) {
      const e = await exportLines({ afterSeq }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ExportError);
      expect((e as ExportError).code).toBe("invalid_after_seq");
    }
  });

  it(
    "a block a tombstone cleared is `{removed_by}`, with no content and no checksum",
    async () => {
      await store.write(async (tx) => {
        const op = await appendOperation(tx, tombstone(t("05:00")));
        await clearBlocks(tx, op.op, [{ seq: 6, path: "request" }]);
      });
      const events = parse(await exportLines()).slice(1);
      expect(events[5]?.c?.["request"]).toEqual({ removed_by: 8 });
      expect(events[5]?.c?.["target"]).toHaveProperty("sum");
    },
    T,
  );

  it(
    "a deletion in its grace period: stops unless told to include; included says so; once executed or cancelled it no longer stops",
    async () => {
      await store.write((tx) => appendOperation(tx, confirmed(t("06:00")))); // 9
      const refused = await exportLines().catch((x: unknown) => x);
      expect(refused).toBeInstanceOf(ExportError);
      expect((refused as ExportError).code).toBe("pending_deletion_unsupported");

      const [manifest, ...events] = parse(await exportLines({ includePendingDeletion: true }));
      expect(manifest).toMatchObject({ pending_deletions: "included", upto: 9, events: 9 });
      expect(events).toHaveLength(9);

      // Executed: no longer pending.
      await store.write((tx) => appendOperation(tx, tombstone(t("07:00")))); // 10
      const [m2] = parse(await exportLines());
      expect(m2).toMatchObject({ pending_deletions: "placeholder", upto: 10 });
    },
    T,
  );

  it(
    "a sink that fails stops the read at that line, and the store is free for the next write",
    async () => {
      let calls = 0;
      const e = await store
        .read((tx) =>
          writeExport(tx, { exportedAt: EXPORTED_AT, includePendingDeletion: true }, async () => {
            calls += 1;
            if (calls === 3) throw new Error("the reader went away");
          }),
        )
        .catch((x: unknown) => x);
      expect((e as Error).message).toBe("the reader went away");
      expect(calls).toBe(3); // the manifest, one event, the failing one: nothing more was read out
      // No transaction left open: a write goes through at once.
      await store.write((tx) => appendOperation(tx, write(t("11:00"), "99")));
    },
    T,
  );

  it(
    "in steps, a transaction each: the same lines as in one; a deletion confirmed between steps stops it",
    async () => {
      const whole = await exportLines({ includePendingDeletion: true });
      const p = { exportedAt: EXPORTED_AT };
      const start = await store.read((tx) => exportStart(tx, p));
      const lines = [start.line];
      let from: number | undefined = start.after;
      let steps = 0;
      while (from !== undefined) {
        const at = from;
        const b: { lines: readonly string[]; next: number | undefined } = await store.read((tx) =>
          exportBatch(tx, start, at, 2),
        );
        lines.push(...b.lines);
        from = b.next;
        steps += 1;
      }
      expect(steps).toBeGreaterThan(3);
      expect(lines.slice(1)).toEqual(whole.slice(1));
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({
        upto: start.upto,
        pending_deletions: "placeholder",
      });

      // Between two steps a deletion is confirmed: the next step stops, without its lines.
      const again = await store.read((tx) => exportStart(tx, p));
      const first = await store.read((tx) => exportBatch(tx, again, again.after, 2));
      expect(first.lines).toHaveLength(2);
      await store.write((tx) => appendOperation(tx, confirmed(t("12:00"), `pi_${"8".repeat(16)}`)));
      const e = await store
        .read((tx) => exportBatch(tx, again, first.next ?? 0, 2))
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ExportError);
      expect((e as ExportError).code).toBe("changed_during_export");
      // The event appended after the start is not in it: nothing past `upto` is read.
      expect(again.upto).toBeLessThan(
        (await store.read((tx) => exportStart(tx, { ...p, includePendingDeletion: true }))).upto,
      );
    },
    T,
  );
});

describe("a deletion executed between two steps", () => {
  let fresh: PgliteTenantStore;
  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "saveslot-export-"));
    roots.push(root);
    fresh = await testBackend().open(
      { kind: "pglite", dir: join(root, "tenant") },
      { create: true },
    );
    await fresh.write((tx) => appendOperation(tx, genesis)); // 1
    await fresh.write((tx) => appendOperation(tx, write(t("04:10"), "45"))); // 2–4
    await fresh.write((tx) => appendOperation(tx, write(t("04:20"), "50"))); // 5–7
  }, T);
  afterAll(async () => {
    await fresh?.close();
  });

  // Clears `seq`'s `request` block by a tombstone appended now (past any earlier `upto`).
  const execute = (seq: number, now: Instant) =>
    fresh.write(async (tx) => {
      const op = await appendOperation(tx, {
        ...tombstone(now),
        events: [
          {
            type: "deletion.executed",
            slot: SLOT,
            trigger: "deletion_expiry",
            blocks: {
              target: { deletion: DELETION, confirmed_event: 8, reason: "expiry" },
              positions: [{ seq, path: "request" }],
            },
          },
        ],
      });
      await clearBlocks(tx, op.op, [{ seq, path: "request" }]);
    });

  for (const includePendingDeletion of [false, true]) {
    it(
      `stops the next step, whose blocks it cleared past upto (include_pending_deletion ${includePendingDeletion})`,
      async () => {
        const start = await fresh.read((tx) =>
          exportStart(tx, { exportedAt: EXPORTED_AT, includePendingDeletion }),
        );
        const first = await fresh.read((tx) => exportBatch(tx, start, start.after, 2));
        expect(first.lines).toHaveLength(2);
        // Not pending at any step: confirmed and executed in one go would leave no trace there.
        const seq = includePendingDeletion ? 6 : 3;
        await execute(seq, t(includePendingDeletion ? "06:00" : "05:00"));
        const e = await fresh
          .read((tx) => exportBatch(tx, start, first.next ?? 0, 10))
          .catch((x: unknown) => x);
        expect(e).toBeInstanceOf(ExportError);
        expect((e as ExportError).code).toBe("changed_during_export");
        // Started after the deletion: the block is `{removed_by}`, the file consistent.
        const lines: string[] = [];
        await fresh.read((tx) =>
          writeExport(tx, { exportedAt: EXPORTED_AT, includePendingDeletion }, async (l) => {
            lines.push(l);
          }),
        );
        expect(parse(lines)[seq]?.c?.["request"]).toHaveProperty("removed_by");
      },
      T,
    );
  }
});
