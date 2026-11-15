// The read buffer (02-architecture §7 «read_log 的持久性»): reads kept in the order recorded, taken
// out to be written and put back ahead of later ones when writing fails; the latest read of a
// target per actor and task (04-contract §2 «兜底»); one buffer per open store.

import type { Instant, PrincipalId, Seq } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { READ_ID, ReadBuffer, type ReadEntry, readBufferOf } from "./reads.ts";

const A = `ci_${"A".repeat(26)}` as PrincipalId;
const B = `ci_${"B".repeat(26)}` as PrincipalId;
const E = `e_${"1".repeat(26)}`;

let n = 0;
function entry(o: Partial<ReadEntry> = {}): ReadEntry {
  n++;
  return {
    read: `rd_${String(n).padStart(16, "0")}`,
    actor: A,
    task: null,
    at: "2026-11-15T08:00:00.000Z" as Instant,
    pos: 10 as Seq,
    operation: "query",
    rows: [],
    coarse: [],
    lastRead: [],
    ...o,
  };
}
const ver = (op: number) => ({ kind: "ver" as const, target: E, op, restoreCount: 0 });

describe("ReadBuffer", () => {
  it("takes reads in order and puts failed ones back ahead of later ones", () => {
    const b = new ReadBuffer();
    const [r1, r2, r3] = [entry(), entry(), entry()];
    b.record(r1);
    b.record(r2);
    const taken = b.take();
    expect(taken).toEqual([r1, r2]);
    expect(b.size).toBe(0);
    b.record(r3);
    b.restore(taken);
    expect(b.take()).toEqual([r1, r2, r3]);
  });

  it("gives the latest read of a target for the same actor and task only", () => {
    const b = new ReadBuffer();
    const r1 = entry({ lastRead: [ver(5)] });
    const r2 = entry({
      lastRead: [ver(7), { kind: "sv", target: "sl_X", op: 2, restoreCount: 0 }],
    });
    const other = entry({ actor: B, lastRead: [ver(9)] });
    const tasked = entry({ task: "t1", lastRead: [ver(11)] });
    for (const r of [r1, r2, other, tasked]) b.record(r);
    const q = { actor: A, task: null, kind: "ver" as const, target: E };
    expect(b.lastRead(q)).toEqual({ op: 7, restoreCount: 0, read: r2.read });
    expect(b.lastRead({ ...q, actor: B })).toEqual({ op: 9, restoreCount: 0, read: other.read });
    expect(b.lastRead({ ...q, task: "t1" })).toEqual({
      op: 11,
      restoreCount: 0,
      read: tasked.read,
    });
    expect(b.lastRead({ ...q, task: "t2" })).toBeUndefined();
    expect(b.lastRead({ ...q, kind: "sv", target: "sl_X" })).toEqual({
      op: 2,
      restoreCount: 0,
      read: r2.read,
    });
    expect(b.lastRead({ ...q, kind: "item" })).toBeUndefined();
    expect(b.find(r1.read)).toBe(r1);
  });

  it("is one per store object", () => {
    const s1 = {};
    const s2 = {};
    expect(readBufferOf(s1)).toBe(readBufferOf(s1));
    expect(readBufferOf(s1)).not.toBe(readBufferOf(s2));
  });

  it("reads IDs of rd_ and 16 Crockford characters", () => {
    expect(READ_ID.test(`rd_${"0123456789ABCDEF"}`)).toBe(true);
    expect(READ_ID.test(`rd_${"0123456789ABCDEU"}`)).toBe(false);
    expect(READ_ID.test(`rd_${"0".repeat(15)}`)).toBe(false);
  });
});
