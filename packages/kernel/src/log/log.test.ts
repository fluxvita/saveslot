// The log without storage: building operations (09-event-format §1.5, §2, §3, §4.1;
// 02-architecture §7 «记录时刻») and `verify` over stored rows (03-data-model «完整性与溯源»).
// Fictional IDs and data.

import { createHash } from "node:crypto";
import { canonicalize, GENESIS_PREV_HASH, type Instant } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import {
  buildOperation,
  LogAppendError,
  type LogTail,
  type NewEvent,
  type NewOperation,
  type PreparedOperation,
} from "./build.ts";
import { LogVerifier, type StoredBlockRow, type StoredEventRow } from "./verify.ts";

const USER = `u_${"1".repeat(26)}` as const;
const CONN = `ci_${"2".repeat(26)}` as const;
const SLOT = `sl_${"3".repeat(16)}` as const;
const NODE = `n_${"4".repeat(26)}` as const;
const NODE2 = `n_${"5".repeat(26)}` as const;
const ROW = `r_${"6".repeat(26)}` as const;
const ITEM = `pi_${"7".repeat(16)}` as const;

const t = (hhmm: string) => `2026-11-10T${hhmm}:00.000Z` as Instant;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const genesis = (now = t("04:00")): NewOperation => ({
  actor: USER,
  now,
  events: [
    {
      type: "tenant.genesis",
      node_id: NODE,
      blocks: {
        tenant: { tenant_id: `tn_${"8".repeat(26)}`, storage_format: 1, event_format: 1 },
        user: { principal: USER, kind: "user" },
        system: { principal: "system", kind: "system" },
      },
    },
  ],
});

const ctx = { now: t("04:10"), today: "2026-11-10", ruleset_version: 1, policy_version: 1 };

/** A write: head, one source, one base write with a value block. */
const write = (now: Instant, value = "45"): NewOperation => ({
  actor: CONN,
  now,
  events: [
    {
      type: "write.head",
      slot: SLOT,
      blocks: {
        ctx: { ...ctx, literal_checker: "literal@1" },
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

const deletionExecuted = (
  now: Instant,
  positions: { seq: number; path: string }[],
): NewOperation => ({
  actor: "system",
  now,
  events: [
    {
      type: "deletion.executed",
      slot: SLOT,
      trigger: "deletion_expiry",
      blocks: {
        target: { deletion: ITEM, confirmed_event: 2, reason: "expiry", by_event: 5 },
        positions,
      },
    },
  ],
});

const restored = (tail: LogTail, highWater: number): NewOperation => ({
  actor: "system",
  now: t("05:00"),
  events: [
    {
      type: "tenant.restored",
      trigger: "restore",
      node_id: NODE2,
      restore_id: `rs_${"9".repeat(16)}`,
      restore_count: 1,
      restored_to: tail.seq,
      high_water: highWater,
      blocks: {},
    },
  ],
});

const tailOf = (p: PreparedOperation): LogTail => {
  const last = p.events[p.events.length - 1];
  if (last === undefined) throw new Error("empty operation");
  return { seq: last.seq, hash: last.hash, at: last.at };
};

/** Builds operations one after another. */
function chain(...ops: ((tail: LogTail | undefined) => NewOperation)[]): PreparedOperation[] {
  const out: PreparedOperation[] = [];
  let tail: LogTail | undefined;
  for (const f of ops) {
    const p = buildOperation(tail, f(tail));
    out.push(p);
    tail = tailOf(p);
  }
  return out;
}

const refuse = (tail: LogTail | undefined, op: NewOperation) =>
  expect(() => buildOperation(tail, op)).toThrow(LogAppendError);

describe("building an operation", () => {
  it("genesis: seq 1, 64 zeros as prev_hash, the header's JCS text and its SHA-256", () => {
    const [g] = chain(() => genesis());
    const e = g?.events[0];
    expect(e?.seq).toBe(1);
    expect(e?.op).toBe(1);
    expect(JSON.parse(e?.header ?? "")).toEqual({
      actor: USER,
      at: t("04:00"),
      node_id: NODE,
      prev_hash: GENESIS_PREV_HASH,
      seq: 1,
      type: "tenant.genesis",
      v: 1,
    });
    expect(e?.header).toBe(canonicalize(JSON.parse(e?.header ?? "")));
    expect(e?.hash).toBe(sha(e?.header ?? ""));
  });

  it("an operation: consecutive seq, op on members only, one at, each prev_hash the previous header's hash", () => {
    const [g, w] = chain(
      () => genesis(),
      () => write(t("04:10")),
    );
    const evs = w?.events ?? [];
    expect(evs.map((e) => e.seq)).toEqual([2, 3, 4]);
    const headers = evs.map((e) => JSON.parse(e.header) as Record<string, unknown>);
    expect(headers.map((h) => h["op"])).toEqual([undefined, 2, 2]);
    expect(evs.map((e) => e.op)).toEqual([2, 2, 2]);
    expect(headers.map((h) => h["at"])).toEqual([t("04:10"), t("04:10"), t("04:10")]);
    expect(headers.map((h) => h["actor"])).toEqual([CONN, CONN, CONN]);
    expect(headers.map((h) => h["prev_hash"])).toEqual([
      g?.events[0]?.hash,
      evs[0]?.hash,
      evs[1]?.hash,
    ]);
    // The header has no content: the value is only in blocks.
    const [, w2] = chain(
      () => genesis(),
      () => write(t("04:10"), "quokka"),
    );
    expect(w2?.events.some((e) => e.blocks.some((b) => b.body.includes("quokka")))).toBe(true);
    expect(w2?.events.every((e) => !e.header.includes("quokka"))).toBe(true);
    const base = evs[2];
    expect(base?.blocks.map((b) => b.path)).toEqual(["fields/f2/0", "target"]);
    for (const b of base?.blocks ?? []) expect(b.checksum).toBe(sha(b.body));
  });

  it("recorded time never goes back: a now earlier than the previous event's at takes that at", () => {
    const [, w1, w2] = chain(
      () => genesis(t("04:00")),
      () => write(t("04:30")),
      () => write(t("04:20")),
    );
    expect(w1?.at).toBe(t("04:30"));
    expect(w2?.at).toBe(t("04:30"));
    expect(w2?.events.every((e) => e.at === t("04:30"))).toBe(true);
  });

  it("index columns from the target block: table, row or entity, the referenced event", () => {
    const [, w, d] = chain(
      () => genesis(),
      () => write(t("04:10")),
      () => deletionExecuted(t("04:20"), [{ seq: 3, path: "text" }]),
    );
    expect(w?.events[2]?.target).toEqual({ table: "t1", row: ROW, event: null });
    expect(w?.events[0]?.target).toEqual({ table: null, row: null, event: null });
    expect(d?.events[0]?.target).toEqual({ table: null, row: null, event: 5 });
  });

  it("a restore: seq = max(restored_to, high_water) + 1", () => {
    const [, , r] = chain(
      () => genesis(),
      () => write(t("04:10")),
      (tail) => restored(tail as LogTail, 9),
    );
    expect(r?.events[0]?.seq).toBe(10);
    const [, , r2] = chain(
      () => genesis(),
      () => write(t("04:10")),
      (tail) => restored(tail as LogTail, 2),
    );
    expect(r2?.events[0]?.seq).toBe(5);
  });

  describe("refused", () => {
    const [g] = chain(() => genesis());
    const tail = g === undefined ? undefined : tailOf(g);
    const w = write(t("04:10"));
    const [head, source, base] = w.events as [NewEvent, NewEvent, NewEvent];

    it("a first event that is not the genesis event, and a second genesis event", () => {
      refuse(undefined, w);
      refuse(tail, genesis());
    });
    it("a member event first, a head event as a member, an empty operation", () => {
      refuse(tail, { ...w, events: [base] });
      refuse(tail, { ...w, events: [head, head] });
      refuse(tail, { ...w, events: [] });
    });
    it("a trigger on a caller's head event; a system head event without one or with a foreign one", () => {
      refuse(tail, { ...w, events: [{ ...head, trigger: "restore" }, source, base] });
      const d = deletionExecuted(t("04:20"), []);
      const [de] = d.events as [NewEvent];
      const { trigger: _, ...noTrigger } = de;
      refuse(tail, { ...d, events: [noTrigger] });
      refuse(tail, { ...d, events: [{ ...de, trigger: "migration" }] });
      refuse(tail, { ...d, actor: USER });
    });
    it("an actor the type does not allow", () => {
      refuse(tail, { ...w, actor: "system" });
      refuse(tail, { ...w, actor: "nobody" as typeof USER });
    });
    it("slot missing on a slot event, present on a tenant-level one", () => {
      const { slot: _, ...noSlot } = base;
      refuse(tail, { ...w, events: [head, source, noSlot] });
      refuse(tail, { ...w, events: [{ ...head, slot: "sl_bad" as typeof SLOT }, source, base] });
    });
    it("type-specific header fields missing or not allowed", () => {
      refuse(tail, { ...w, events: [{ ...head, node_id: NODE }, source, base] });
      const r = restored(tail as LogTail, 1);
      const [re] = r.events as [NewEvent];
      const { high_water: _, ...noHighWater } = re;
      refuse(tail, { ...r, events: [noHighWater] });
    });
    it("restored_to or imported_upto other than the log's last event", () => {
      const r = restored(tail as LogTail, 1);
      const [re] = r.events as [NewEvent];
      refuse(tail, { ...r, events: [{ ...re, restored_to: 7 }] });
    });
    it("a path outside the type's vocabulary, a missing required block, a value that is not JSON", () => {
      refuse(tail, {
        ...w,
        events: [head, source, { ...base, blocks: { ...base.blocks, "fields/x2/0": {} } }],
      });
      refuse(tail, { ...w, events: [head, source, { ...base, blocks: { "fields/f2/0": {} } }] });
      refuse(tail, {
        ...w,
        events: [head, source, { ...base, blocks: { ...base.blocks, "fields/f2/1": Number.NaN } }],
      });
    });
    it("a member event in another slot than its head event", () => {
      refuse(tail, { ...w, events: [head, source, { ...base, slot: `sl_${"5".repeat(16)}` }] });
    });
    it("now that is not an instant", () => {
      refuse(tail, { ...w, now: "2026-11-10" as Instant });
    });
  });
});

// --- verify ---------------------------------------------------------------------------------

function rows(ops: PreparedOperation[]): { events: StoredEventRow[]; blocks: StoredBlockRow[] } {
  const events: StoredEventRow[] = [];
  const blocks: StoredBlockRow[] = [];
  for (const p of ops) {
    for (const e of p.events) {
      const target = e.blocks.find((b) => b.path === "target");
      events.push({
        seq: e.seq,
        header: e.header,
        header_hash: e.hash,
        type: e.type,
        actor: e.actor,
        at: e.at,
        op: e.op,
        slot: e.slot,
        target_table: e.target.table,
        target_row: e.target.row,
        target_event: e.target.event,
        target_body: target?.body ?? null,
        paths: e.blocks.map((b) => b.path),
        positions_body: e.blocks.find((b) => b.path === "positions")?.body ?? null,
      });
      for (const b of e.blocks) {
        blocks.push({
          seq: e.seq,
          path: b.path,
          body: b.body,
          checksum: b.checksum,
          removed_by: null,
        });
      }
    }
  }
  return { events, blocks };
}

function verify(r: { events: StoredEventRow[]; blocks: StoredBlockRow[] }) {
  const v = new LogVerifier();
  for (const e of r.events) v.addEvent(e);
  for (const b of r.blocks) v.addBlock(b);
  return v.result();
}

describe("verify", () => {
  const log = () =>
    rows(
      chain(
        () => genesis(),
        () => write(t("04:10"), "45"),
        () => write(t("04:20"), "50"),
        () => write(t("04:30"), "55"),
      ),
    );

  it("an untouched log: intact, no mismatch", () => {
    expect(verify(log())).toEqual({
      events: 10,
      chain: { intact: true },
      checksum_mismatch: [],
      removed: 0,
      gaps: [],
      index_mismatch: [],
    });
  });

  it("a header changed, its hash column not: the chain breaks at that event", () => {
    // The recomputed hash differs from the stored one. The actor column, still the old actor,
    // no longer matches the header either.
    const r = log();
    const e = r.events[4] as StoredEventRow;
    r.events[4] = { ...e, header: e.header.replace(CONN, `ci_${"3".repeat(26)}`) };
    const res = verify(r);
    expect(res.chain).toEqual({ intact: false, broken_at: 5 });
    expect(res.index_mismatch).toEqual([{ seq: 5 }]);
  });

  it("a header changed together with its hash and index columns: the break shows at the next event", () => {
    const r = log();
    const e = r.events[4] as StoredEventRow;
    const header = e.header.replace(CONN, `ci_${"3".repeat(26)}`);
    r.events[4] = { ...e, header, header_hash: sha(header), actor: `ci_${"3".repeat(26)}` };
    const res = verify(r);
    expect(res.chain).toEqual({ intact: false, broken_at: 6 });
    expect(res.index_mismatch).toEqual([]);
  });

  it("an event missing, or two events swapped: the chain breaks", () => {
    const missing = log();
    missing.events.splice(3, 1);
    expect(verify(missing).chain).toEqual({ intact: false, broken_at: 5 });
    const swapped = log();
    const [a, b] = [swapped.events[3], swapped.events[4]] as [StoredEventRow, StoredEventRow];
    swapped.events[3] = b;
    swapped.events[4] = a;
    expect(verify(swapped).chain.intact).toBe(false);
  });

  it("a header stored in a non-canonical form breaks the chain", () => {
    const r = log();
    const e = r.events[2] as StoredEventRow;
    r.events[2] = { ...e, header: ` ${e.header}` };
    expect(verify(r).chain).toEqual({ intact: false, broken_at: 3 });
  });

  it("content changed without its checksum, or lost without a removal mark: mismatches by position", () => {
    const r = log();
    const i = r.blocks.findIndex((b) => b.seq === 4 && b.path === "fields/f2/0");
    const j = r.blocks.findIndex((b) => b.seq === 7 && b.path === "fields/f2/0");
    r.blocks[i] = { ...(r.blocks[i] as StoredBlockRow), body: '{"status":"applied","value":"46"}' };
    r.blocks[j] = { ...(r.blocks[j] as StoredBlockRow), body: null, checksum: null };
    const res = verify(r);
    expect(res.checksum_mismatch).toEqual([
      { seq: 4, path: "fields/f2/0" },
      { seq: 7, path: "fields/f2/0" },
    ]);
    expect(res.chain).toEqual({ intact: true });
  });

  /** The log with a tombstone (seq 11) that lists the source request of operation 2. */
  const withTombstone = () =>
    rows(
      chain(
        () => genesis(),
        () => write(t("04:10"), "45"),
        () => write(t("04:20"), "50"),
        () => write(t("04:30"), "55"),
        () => deletionExecuted(t("04:40"), [{ seq: 3, path: "request" }]),
      ),
    );
  const remove = (r: ReturnType<typeof rows>, seq: number, path: string, by: number) => {
    const i = r.blocks.findIndex((b) => b.seq === seq && b.path === path);
    r.blocks[i] = {
      ...(r.blocks[i] as StoredBlockRow),
      body: null,
      checksum: null,
      removed_by: by,
    };
  };

  it("a block removed by a tombstone that lists it is counted apart, not as a mismatch", () => {
    const r = withTombstone();
    remove(r, 3, "request", 11);
    const res = verify(r);
    expect(res.removed).toBe(1);
    expect(res.checksum_mismatch).toEqual([]);
    expect(res.chain).toEqual({ intact: true });
  });

  it("a removal mark that names no tombstone, or a tombstone not listing the block, is a mismatch", () => {
    const r = withTombstone();
    remove(r, 3, "request", 7);
    remove(r, 4, "fields/f2/0", 11);
    const res = verify(r);
    expect(res.removed).toBe(0);
    expect(res.checksum_mismatch).toEqual([
      { seq: 3, path: "request" },
      { seq: 4, path: "fields/f2/0" },
    ]);
  });

  /** Drops a content row entirely (no removal mark): from the blocks and the event's paths. */
  const lose = (r: ReturnType<typeof rows>, seq: number, path: string) => {
    r.blocks = r.blocks.filter((b) => !(b.seq === seq && b.path === path));
    const i = r.events.findIndex((e) => e.seq === seq);
    const e = r.events[i] as StoredEventRow;
    r.events[i] = {
      ...e,
      paths: e.paths.filter((p) => p !== path),
      ...(path === "target" ? { target_body: null } : {}),
    };
  };

  it("a required block lost as a whole row is a mismatch at its position", () => {
    const r = log();
    lose(r, 2, "ctx");
    lose(r, 4, "target");
    const res = verify(r);
    expect(res.checksum_mismatch).toEqual([
      { seq: 2, path: "ctx" },
      { seq: 4, path: "target" },
    ]);
    // Without target the index columns are not checked: no index mismatch for seq 4.
    expect(res.index_mismatch).toEqual([]);
    expect(res.chain).toEqual({ intact: true });
  });

  it("an optional block lost as a whole row is not found (03-data-model «完整性与溯源»)", () => {
    const r = log();
    lose(r, 4, "fields/f2/0");
    expect(verify(r).checksum_mismatch).toEqual([]);
  });

  it("an import's event follows the last imported event: imported_upto must be that seq", () => {
    const imported = (upto: number): NewOperation => ({
      actor: USER,
      now: t("05:00"),
      events: [
        {
          type: "tenant.imported",
          node_id: NODE2,
          restore_count: 1,
          imported_upto: upto,
          blocks: {
            tenant: {
              tenant_id: `tn_${"9".repeat(26)}`,
              previous_tenant_id: `tn_${"8".repeat(26)}`,
              storage_format: 1,
              event_format: 1,
            },
            user: { principal: USER, kind: "user" },
            export: { exported_at: t("04:50"), pending_deletions: "placeholder" },
          },
        },
      ],
    });
    const ops = chain(
      () => genesis(),
      () => write(t("04:10")),
      (tail) => imported((tail as LogTail).seq),
    );
    expect(verify(rows(ops)).chain).toEqual({ intact: true });
    // The same event recording another import point (hash column recomputed with it).
    const r = rows(ops);
    const e = r.events[4] as StoredEventRow;
    const header = e.header.replace('"imported_upto":4', '"imported_upto":3');
    r.events[4] = { ...e, header, header_hash: sha(header) };
    expect(verify(r).chain).toEqual({ intact: false, broken_at: 5 });
  });

  it("a restore's gap is listed, not a break; a gap without a restore event is a break", () => {
    const ops = chain(
      () => genesis(),
      () => write(t("04:10")),
      (tail) => restored(tail as LogTail, 9),
      () => write(t("05:10")),
    );
    const res = verify(rows(ops));
    expect(res.chain).toEqual({ intact: true });
    expect(res.gaps).toEqual([{ after: 4, before: 10, restore: 10 }]);
    // The same gap, the restore event's type changed (hash and type columns with it).
    const r = rows(ops);
    const e = r.events[4] as StoredEventRow;
    const header = e.header.replace("tenant.restored", "write.head");
    r.events[4] = { ...e, type: "write.head", header, header_hash: sha(header) };
    expect(verify(r).chain).toEqual({ intact: false, broken_at: 10 });
  });

  it("index columns that differ from the header or the target block", () => {
    const r = log();
    const e = r.events[3] as StoredEventRow;
    r.events[3] = { ...e, target_row: `r_${"0".repeat(26)}` };
    const f = r.events[5] as StoredEventRow;
    r.events[5] = { ...f, op: 1 };
    const res = verify(r);
    expect(res.index_mismatch).toEqual([{ seq: 4 }, { seq: 6 }]);
    expect(res.chain).toEqual({ intact: true });
  });
});
