// The kernel's log module on the PGlite backend (02-architecture §4 `log`, §11 «测试矩阵»: kernel
// tests run on each backend). Append, read back, clear by position, and `verify` against tampering
// done directly in the tables. Fictional IDs and data.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOperation,
  clearBlocks,
  continueOperation,
  LogAppendError,
  type NewOperation,
  readEvents,
  readTail,
  verifyLog,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

const USER = `u_${"1".repeat(26)}` as const;
const CONN = `ci_${"2".repeat(26)}` as const;
const SLOT = `sl_${"3".repeat(16)}` as const;
const ROW = `r_${"6".repeat(26)}` as const;
type Instant = NewOperation["now"];
const t = (hhmm: string) => `2026-11-10T${hhmm}:00.000Z` as Instant;

const genesis: NewOperation = {
  actor: USER,
  now: t("04:00"),
  events: [
    {
      type: "tenant.genesis",
      node_id: `n_${"4".repeat(26)}`,
      blocks: {
        tenant: { tenant_id: `tn_${"8".repeat(26)}`, storage_format: 1, event_format: 1 },
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

const roots: string[] = [];
let store: PgliteTenantStore;
const T = 60_000;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "saveslot-log-"));
  roots.push(root);
  store = await testBackend().open({ kind: "pglite", dir: join(root, "tenant") }, { create: true });
  await store.write((tx) => appendOperation(tx, genesis));
  await store.write((tx) => appendOperation(tx, write(t("04:10"), "45")));
  await store.write((tx) => appendOperation(tx, write(t("04:05"), "50")));
}, T);

afterAll(async () => {
  await store?.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, 120_000);

describe("the log on PGlite", () => {
  it("appends with consecutive seq; the tail is the last event; at never goes back", async () => {
    const tail = await store.read((tx) => readTail(tx));
    expect(tail?.seq).toBe(7);
    expect(tail?.at).toBe(t("04:10"));
    const evs = await store.read((tx) => readEvents(tx, 1, 7));
    expect(evs.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(evs.map((e) => e.header["op"])).toEqual([undefined, undefined, 2, 2, undefined, 5, 5]);
    expect(evs[6]?.blocks.get("fields/f2/0")).toEqual({
      state: "present",
      value: { status: "applied", value: "50" },
    });
  });

  it("a refused operation inserts nothing", async () => {
    await expect(
      store.write((tx) => appendOperation(tx, { ...write(t("04:20"), "x"), actor: "system" })),
    ).rejects.toThrow(LogAppendError);
    expect((await store.read((tx) => readTail(tx)))?.seq).toBe(7);
  });

  it(
    "verify: intact; then a tampered block, a block cleared by a tombstone, a tampered header",
    async () => {
      // Small batches to cover the paging.
      expect(await store.read((tx) => verifyLog(tx, 2))).toEqual({
        events: 7,
        chain: { intact: true },
        checksum_mismatch: [],
        removed: 0,
        gaps: [],
        index_mismatch: [],
      });

      // Bypassing the log: change a value without its checksum.
      await store.write((tx) =>
        tx.query(
          `UPDATE content SET body = '{"status":"applied","value":"46"}' WHERE seq = 4 AND path = 'fields/f2/0'`,
        ),
      );
      // A tombstone (seq 8) lists the source request of operation 5 and clears it; a second
      // clear of the same block is a no-op and keeps the first tombstone.
      const cleared = await store.write(async (tx) => {
        const op = await appendOperation(tx, {
          actor: "system",
          now: t("04:30"),
          events: [
            {
              type: "deletion.executed",
              slot: SLOT,
              trigger: "deletion_expiry",
              blocks: {
                target: { deletion: `pi_${"7".repeat(16)}`, confirmed_event: 2, reason: "expiry" },
                positions: [{ seq: 6, path: "request" }],
              },
            },
          ],
        });
        const a = await clearBlocks(tx, op.op, [{ seq: 6, path: "request" }]);
        const b = await clearBlocks(tx, 100, [{ seq: 6, path: "request" }]);
        return [op.op, a, b];
      });
      expect(cleared).toEqual([8, 1, 0]);
      const evs = await store.read((tx) => readEvents(tx, 6, 6));
      expect(evs[0]?.blocks.get("request")).toEqual({ state: "removed", by: 8 });

      let res = await store.read((tx) => verifyLog(tx, 2));
      expect(res.checksum_mismatch).toEqual([{ seq: 4, path: "fields/f2/0" }]);
      expect(res.removed).toBe(1);
      expect(res.chain).toEqual({ intact: true });

      // Bypassing the log: another actor written into a header, the hash column left as it was.
      // The recomputed hash differs from the stored one: the chain breaks at that event. The
      // actor column, still the old actor, no longer matches the header either.
      await store.write((tx) =>
        tx.query("UPDATE events SET header = replace(header, $1, $2) WHERE seq = 5", [
          CONN,
          `ci_${"9".repeat(26)}`,
        ]),
      );
      res = await store.read((tx) => verifyLog(tx, 2));
      expect(res.chain).toEqual({ intact: false, broken_at: 5 });
      expect(res.index_mismatch).toEqual([{ seq: 5 }]);

      // Changing the hash and actor columns with it hides the change at that event: the break
      // shows at the next one, whose prev_hash no longer matches.
      await store.write(async (tx) => {
        const r = await tx.query<{ header: string }>("SELECT header FROM events WHERE seq = 5");
        const header = r.rows[0]?.header ?? "";
        await tx.query("UPDATE events SET header_hash = $1, actor = $2 WHERE seq = 5", [
          createHash("sha256").update(header, "utf8").digest("hex"),
          `ci_${"9".repeat(26)}`,
        ]);
      });
      res = await store.read((tx) => verifyLog(tx, 2));
      expect(res.chain).toEqual({ intact: false, broken_at: 6 });
      expect(res.index_mismatch).toEqual([]);

      // A required block lost as a whole row (05's ctx), and a removal mark naming no tombstone.
      await store.write(async (tx) => {
        await tx.query("DELETE FROM content WHERE seq = 5 AND path = 'ctx'");
        await tx.query(
          "UPDATE content SET body = NULL, checksum = NULL, removed_by = 3 WHERE seq = 7 AND path = 'target'",
        );
      });
      res = await store.read((tx) => verifyLog(tx, 2));
      expect(res.checksum_mismatch).toEqual([
        { seq: 4, path: "fields/f2/0" },
        { seq: 5, path: "ctx" },
        { seq: 7, path: "target" },
      ]);
    },
    T,
  );
});

describe("continuing an operation on PGlite", () => {
  let fresh: PgliteTenantStore;
  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "saveslot-log-continue-"));
    roots.push(root);
    fresh = await testBackend().open(
      { kind: "pglite", dir: join(root, "tenant") },
      { create: true },
    );
    await fresh.write((tx) => appendOperation(tx, genesis));
  }, T);
  afterAll(async () => {
    await fresh?.close();
  }, T);
  const source = (v: string) => ({
    type: "source.recorded" as const,
    slot: SLOT,
    blocks: { target: { kind: "api_call" }, request: { f2: v } },
  });

  it(
    "in the transaction that appended it: the events follow its last, op and at its own; verify passes",
    async () => {
      const c = await fresh.write(async (tx) => {
        const w = await appendOperation(tx, write(t("04:10"), "45"));
        return continueOperation(tx, w, [source("45")]);
      });
      expect([c.op, c.at, c.events.map((e) => e.seq)]).toEqual([2, t("04:10"), [5]]);
      const [e] = await fresh.read((tx) => readEvents(tx, 5, 5));
      expect([e?.header["op"], e?.header["at"], e?.header["actor"]]).toEqual([2, t("04:10"), CONN]);
      expect(await fresh.read((tx) => verifyLog(tx))).toMatchObject({
        events: 5,
        chain: { intact: true },
        checksum_mismatch: [],
        index_mismatch: [],
      });
    },
    T,
  );

  it(
    "another operation appended after it: refused, nothing inserted",
    async () => {
      const tails = await fresh.write(async (tx) => {
        const w = await appendOperation(tx, write(t("04:20"), "50"));
        await appendOperation(tx, write(t("04:20"), "55"));
        const before = (await readTail(tx))?.seq;
        await expect(continueOperation(tx, w, [source("50")])).rejects.toThrow(LogAppendError);
        return [before, (await readTail(tx))?.seq];
      });
      expect(tails).toEqual([11, 11]);
      expect(await fresh.read((tx) => verifyLog(tx))).toMatchObject({ chain: { intact: true } });
    },
    T,
  );
});
