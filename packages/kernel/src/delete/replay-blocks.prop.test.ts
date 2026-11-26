// Several deletions of a row confirmed and cancelled in turn, against a model of the log's blocks
// (09 §3.5, §5.7, §5.9): the blocks as written and each event's `restated/<k>`, in log order; each
// deletion's list of positions worked out when it is confirmed, from its replay alone (09 §3.5
// rule 1); a cancelled deletion's blocks no longer counting (§5.7). With every deletion still
// pending carried out, the last readable block of each item is the live replay's item: a replay
// from an empty store gives the state the log gave live.
//
// The rest of the kernel's deletion tests compare restatements laid over (`overlay`) with the
// replay on both sides, and none models a block a deletion's own list clears; this one works the
// list out on its own, as the specification defines it, and is what catches rule 2 (09 §5.9).

import { evaluateLog, type Op } from "@fluxvita/saveslot-reference";
import {
  EVENT as EVENT_SCHEMA,
  propRuns,
  STATE as STATE_SCHEMA,
} from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { JudgeError } from "../judge/errors.ts";
import { itemsByRecords } from "../judge/fates.ts";
import type { ItemRef, OpRecord, Restatement, TableShape } from "../judge/model.ts";
import { cancellationResult, deletionResult } from "../judge/replay-deletion.ts";
import { type GivenBlock, givenByRecords, overlay, restatedDeps } from "../judge/restate.ts";
import {
  type Decision,
  deletedContributions,
  judged,
  scenario,
} from "../judge/scenarios.fixture.ts";
import { RowState } from "../judge/state.ts";
import { BLOCK_CASES } from "./replay-blocks.cases.fixture.ts";

vi.setConfig({ testTimeout: 600_000 });

const RUNS = propRuns(300);
// A fixed seed by default, so that a run says the same as the last one; the soak runs
// (`PROP_COVERAGE` set, scripts/soak-props.ts) keep fast-check's fresh random seed, `PROP_SEED`
// replays one.
const SEED =
  process.env["PROP_SEED"] !== undefined
    ? Number(process.env["PROP_SEED"])
    : process.env["PROP_COVERAGE"] === undefined
      ? 20261126
      : undefined;

const ref = (d: ItemRef) => `${d.event}/${d.target}/${d.k}`;
const etOf = (d: { event: number; target: string }) => `${d.event}/${d.target}`;

/** A cancellation with no write since the deletion it cancels. */
const NO_GRACE = {
  cancelledOp: Number.MAX_SAFE_INTEGER,
  coveredSince: Number.MAX_SAFE_INTEGER,
  keptEffective: new Set<string>(),
  effectiveSince: () => 0,
};

/** A block of the log: an item's block as written, or a deletion's or cancellation's restatement. */
interface Block {
  readonly from: string;
  readonly kind: "written" | "confirm" | "cancel";
  readonly item: string;
  readonly b: GivenBlock;
  readonly r?: Restatement;
}

/** The log of one row: its records, and its deletion and cancellation events in turn. */
class Session {
  readonly table: TableShape;
  readonly records: readonly OpRecord[];
  readonly deletions = new Map<
    string,
    { deleted: ReadonlySet<string>; cancelled: boolean; positions: Set<Block> }
  >();
  readonly log: { kind: "confirm" | "cancel"; id: string; restated: readonly Restatement[] }[] = [];
  readonly blocks: Block[] = [];
  /** The deletion and cancellation events in turn, by deletion: `confirm D<i>` or `cancel D<i>`. */
  readonly trace: string[] = [];
  live: readonly OpRecord[];

  constructor(table: TableShape, records: readonly OpRecord[]) {
    this.table = table;
    this.records = records;
    this.live = records;
    for (const [et, bs] of givenByRecords(records))
      for (const b of bs)
        this.blocks.push({ from: "written", kind: "written", item: `${et}/${b.k}`, b });
  }

  /** What the deletions still pending take away, but `except`'s. */
  pending(except?: string): Set<string> {
    const out = new Set<string>();
    for (const [id, d] of this.deletions)
      if (!d.cancelled && id !== except) for (const k of d.deleted) out.add(k);
    return out;
  }

  /** The blocks last given, `gone` taken away; a cancelled deletion's and those in `skip` left out. */
  latest(gone: ReadonlySet<string>, skip: readonly string[] = []): Map<string, GivenBlock[]> {
    let m: Map<string, GivenBlock[]> = new Map(
      [...givenByRecords(this.records)].filter(([et]) => !gone.has(et)),
    );
    for (const e of this.log) {
      const off = this.deletions.get(e.id)?.cancelled === true || skip.includes(e.id);
      if (e.kind === "confirm" && off) continue;
      m = overlay(m, e.restated, gone, this.records);
    }
    return m;
  }

  items() {
    return itemsByRecords(new RowState(this.table, this.records));
  }

  /**
   * Deletion `id` confirmed: its event worked out with the deletions still pending, rule 2 told
   * what its own list clears; its list of positions from its replay alone (09 §3.5 rule 1): a block
   * as written of a contribution it deletes, a restatement of an item it deletes or restates, and
   * any block one of whose deps it deletes or restates, or a carried item of which it deletes or
   * restates as dropped.
   */
  confirm(id: string, deleted: ReadonlySet<string>): void {
    const before = this.pending();
    const pendingIds = [...this.deletions].filter(([, d]) => !d.cancelled).map(([x]) => x);
    const alone = deletionResult(
      this.table,
      this.records,
      deleted,
      new Set(),
      this.items(),
      () => [],
      this.latest(new Set(), pendingIds),
    ).replay.restated;
    const own = new Map(alone.map((r) => [ref(r.item), r]));
    const here = (d: ItemRef) => deleted.has(etOf(d));
    const dep = (d: ItemRef) => here(d) || own.has(ref(d));
    const carried = (d: ItemRef) => here(d) || own.get(ref(d))?.status === "dropped";
    const res = deletionResult(
      this.table,
      this.records,
      new Set([...before, ...deleted]),
      before,
      this.items(),
      () => [],
      this.latest(before),
      new Set(),
      // As the delete operation passes it: only with another deletion on the row.
      pendingIds.length > 0 ? { dep, carried } : undefined,
    );
    const positions = new Set<Block>();
    for (const blk of this.blocks) {
      const restates = blk.r !== undefined && dep(blk.r.item);
      if (
        (blk.kind === "written" && deleted.has(blk.item.slice(0, blk.item.lastIndexOf("/")))) ||
        restates ||
        blk.b.deps.some(dep) ||
        (blk.b.carried ?? []).some(carried)
      )
        positions.add(blk);
    }
    this.deletions.set(id, { deleted, cancelled: false, positions });
    this.trace.push(`confirm ${id}`);
    this.push("confirm", id, res.replay.restated);
    this.live = res.replay.records;
  }

  /** Deletion `id` cancelled, with no write since: its blocks no longer count (§5.7). */
  cancel(id: string): void {
    const d = this.deletions.get(id);
    if (d === undefined || d.cancelled) throw new Error(`no pending deletion ${id}`);
    const others = this.pending(id);
    // The items whose last interval block came from the cancelled deletion (09 §5.9 rule 3).
    const at = this.log.findIndex((e) => e.kind === "confirm" && e.id === id);
    const later = new Set(
      this.log
        .slice(at + 1)
        .filter((e) => !(e.kind === "confirm" && this.deletions.get(e.id)?.cancelled))
        .flatMap((e) => e.restated.map((r) => ref(r.item))),
    );
    const from = new Set(
      (this.log[at]?.restated ?? [])
        .filter((r) => r.status !== "dropped")
        .map((r) => ref(r.item))
        .filter((k) => !later.has(k)),
    );
    const back = cancellationResult(
      this.table,
      this.records,
      others,
      d.deleted,
      this.items(),
      this.latest(others, [id]),
      from,
      () => [],
      NO_GRACE,
    );
    this.deletions.set(id, { ...d, cancelled: true });
    this.trace.push(`cancel ${id}`);
    this.push("cancel", id, back.replay.restated);
    this.live = back.replay.records;
  }

  push(kind: "confirm" | "cancel", id: string, restated: readonly Restatement[]): void {
    this.log.push({ kind, id, restated });
    for (const r of restated) {
      const laid = overlay(new Map(), [r], new Set(), this.records).get(etOf(r.item))?.[0];
      const b: GivenBlock = laid ?? {
        k: r.item.k,
        status: r.status,
        valid: r.valid ?? [],
        deps: restatedDeps(r),
      };
      this.blocks.push({ from: id, kind, item: ref(r.item), b, r });
    }
  }

  /** Every deletion still pending carried out, replayed from an empty store: each item's last block. */
  fromEmpty(): string[] {
    const listed = new Set<Block>();
    for (const d of this.deletions.values())
      if (!d.cancelled) for (const p of d.positions) listed.add(p);
    const last = new Map<string, Block>();
    for (const blk of this.blocks) {
      if (blk.kind === "confirm" && this.deletions.get(blk.from)?.cancelled) continue;
      if (listed.has(blk)) continue;
      last.set(blk.item, blk);
    }
    const out: string[] = [];
    for (const [item, blk] of last) {
      if (blk.b.status === "dropped") continue;
      const valid = this.table.kind === "state" ? JSON.stringify(blk.b.valid) : "";
      out.push(`${item} ${blk.b.status} ${valid} ${blk.b.content?.kind ?? "?"}`);
    }
    return out.sort();
  }

  /** The live replay's items. */
  liveItems(): string[] {
    const out: string[] = [];
    for (const r of this.live) {
      if (!("items" in r)) continue;
      for (const x of r.items) {
        const valid = this.table.kind === "state" ? JSON.stringify(x.valid) : "";
        out.push(`${r.event}/${x.target}/${x.k} ${x.status} ${valid} ${x.content.kind}`);
      }
    }
    return out.sort();
  }
}

const sourcesOf = (ops: readonly Op[]) =>
  [
    ...new Set(
      ops.flatMap((o) =>
        o.kind === "write"
          ? [...Object.values(o.fields).flatMap((x) => x?.sources ?? []), ...(o.validSources ?? [])]
          : o.kind === "revoke"
            ? [...(o.validSources ?? [])]
            : [],
      ),
    ),
  ].sort();

type Step = { readonly c: number } | { readonly x: number };

/** The log judged, then each step in turn: confirm `D<c>` (deleting `dels[c]`), or cancel `D<x>`. */
function runScript(
  schema: typeof STATE_SCHEMA,
  ops: readonly Op[],
  decisions: readonly Decision[],
  dels: readonly (readonly string[])[],
  script: readonly Step[],
): Session {
  const isState = schema.kind === "state";
  const j = judged(schema, ops as Op[], decisions as Decision[]);
  const kept = j.steps.map((x) => x.op);
  const s = new Session(
    j.table,
    j.steps.map((x) => x.judgement.record),
  );
  for (const step of script) {
    if ("c" in step) {
      const id = `D${step.c}`;
      if (!s.deletions.has(id))
        s.confirm(id, deletedContributions(kept, new Set(dels[step.c] ?? []), isState));
    } else {
      const d = s.deletions.get(`D${step.x}`);
      if (d !== undefined && !d.cancelled) s.cancel(`D${step.x}`);
    }
  }
  return s;
}

const refused = (e: unknown) => e instanceof JudgeError && e.reason === "not_implemented";

describe.each([
  ["state", STATE_SCHEMA, true],
  ["event", EVENT_SCHEMA, false],
] as const)("%s table", (_, schema, isState) => {
  it("a replay from an empty store gives what the deletions gave live", () => {
    const seen = { runs: 0, refused: 0, several: 0 };
    fc.assert(
      fc.property(
        scenario(isState),
        fc.array(fc.nat(), { minLength: 2, maxLength: 4 }),
        fc.array(
          fc.oneof(fc.record({ c: fc.nat({ max: 3 }) }), fc.record({ x: fc.nat({ max: 3 }) })),
          { minLength: 2, maxLength: 6 },
        ),
        ({ ops, decisions }, picks, script) => {
          const srcs = sourcesOf(ops);
          if (srcs.length < 2) return;
          // One source each, none twice (a deletion of a source deleted already deletes nothing).
          const used = new Set<string>();
          const dels = picks.map((p) => {
            const x = srcs[p % srcs.length] as string;
            if (used.has(x)) return [] as string[];
            used.add(x);
            return [x];
          });
          seen.runs++;
          let s: Session;
          try {
            s = runScript(schema, ops, decisions, dels, script);
          } catch (e) {
            if (refused(e)) {
              seen.refused++;
              return;
            }
            throw e;
          }
          if (s.deletions.size >= 2) seen.several++;
          expect({ ops, decisions, dels, script, fromEmpty: s.fromEmpty() }).toEqual({
            ops,
            decisions,
            dels,
            script,
            fromEmpty: s.liveItems(),
          });
        },
      ),
      { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) },
    );
    // Against a generator gone degenerate: most samples replay, and many hold several deletions.
    expect(seen.refused).toBeLessThan(seen.runs / 2);
    expect(seen.several).toBeGreaterThan(seen.runs / 8);
  });
});

describe("fixed cases", () => {
  for (const c of BLOCK_CASES) {
    for (const table of c.tables) {
      it(`${c.name}, ${table} table`, () => {
        const s = runScript(
          table === "state" ? STATE_SCHEMA : EVENT_SCHEMA,
          c.ops,
          c.decisions,
          c.dels,
          c.script,
        );
        expect(s.fromEmpty()).toEqual(s.liveItems());
      });
    }
  }

  it("a deletion cancelled after another cleared the block of an item it had dropped", () => {
    // #50 writes "1" from 11-01 to the next change, resting on #40. A deletes S2 and restates #50 as
    // dropped; B deletes SZ, restating #40 on its own, so B's list clears #50's blocks (by its dep)
    // and A's block saying it is dropped. A cancelled: #50 is in effect again, live; replayed from
    // an empty store with B carried out, it must be given by an event still readable.
    const g = (from: string, to: string | null | "next") => ({
      valid: {
        from: { mode: "given", value: from },
        to:
          to === null
            ? { mode: "open" }
            : to === "next"
              ? { mode: "next_change" }
              : { mode: "given", value: to },
      },
    });
    const ops = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        ...g("2026-10-01", null),
        fields: { f2: { value: "1", sources: ["S1"] } },
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        ...g("2026-11-01", null),
        fields: { f2: { value: "2", sources: ["S2"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        ...g("2026-11-20", null),
        fields: { f2: { value: "9", sources: ["SZ"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 30,
        ...g("2026-11-10", "next"),
        fields: { f2: { value: "3", sources: ["SY"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 40,
        ...g("2026-11-01", "next"),
        fields: { f2: { value: "1", sources: ["SX"], explicit: false } },
        acknowledge: ["overwrite"],
      },
    ] as unknown as Op[];
    const s = runScript(STATE_SCHEMA, ops, [], [["S2"], ["SZ"]], [{ c: 0 }, { c: 1 }, { x: 0 }]);
    expect(s.liveItems().some((x) => x.startsWith("51/f2/0 applied"))).toBe(true);
    expect(s.fromEmpty()).toEqual(s.liveItems());
  });
});

/** The block model replayed from an empty store, against the reference evaluator given the same
 * deletion and cancellation events in turn: an oracle of its own, not the kernel's blocks. */
function againstReference(
  schema: typeof STATE_SCHEMA,
  ops: readonly Op[],
  dels: readonly (readonly string[])[],
  script: readonly Step[],
): { fromEmpty: string[]; reference: string[] } {
  const s = runScript(schema, ops, [], dels, script);
  const kept = judged(schema, ops as Op[], []).steps.map((x) => x.op);
  let op = Math.max(...kept.map((o) => Math.max(o.op, o.event)));
  const entries: unknown[] = [...kept];
  for (const t of s.trace) {
    const [kind, id] = t.split(" ") as [string, string];
    entries.push(
      kind === "confirm"
        ? { kind: "deletion", op: ++op, id, sources: dels[Number(id.slice(1))] }
        : { kind: "cancel", op: ++op, id },
    );
  }
  const valid = (v: unknown) => (schema.kind === "state" ? JSON.stringify(v) : "");
  const reference = evaluateLog(schema, entries as never)
    .final.items.filter((x) => x.status !== "dropped")
    .map((x) => `${x.event}/${x.target}/${x.k} ${x.status} ${valid(x.valid)}`)
    .sort();
  const fromEmpty = s
    .fromEmpty()
    .map((x) => x.slice(0, x.lastIndexOf(" ")))
    .sort();
  return { fromEmpty, reference };
}

describe("histories around an item an earlier deletion dropped, against the reference evaluator", () => {
  // #50 writes "1" from 11-01 to the next change, resting on #40 ("3" from 11-10 to the next
  // change, resting on #30). A deletes S2 (#20's words) and restates #50 as dropped. Each history
  // goes on otherwise: a later deletion whose list does not touch A's block, one that deletes #50
  // itself, one or two that clear it, cancellations between and after, the order swapped.
  const g = (from: string, to: string | null | "next") => ({
    valid: {
      from: { mode: "given", value: from },
      to:
        to === null
          ? { mode: "open" }
          : to === "next"
            ? { mode: "next_change" }
            : { mode: "given", value: to },
    },
  });
  const OPS = [
    {
      kind: "write",
      op: 10,
      event: 11,
      seen: 0,
      ...g("2026-10-01", null),
      fields: { f2: { value: "1", sources: ["S1"] } },
    },
    {
      kind: "write",
      op: 20,
      event: 21,
      seen: 10,
      ...g("2026-11-01", null),
      fields: { f2: { value: "2", sources: ["S2"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 30,
      event: 31,
      seen: 20,
      ...g("2026-11-20", null),
      fields: { f2: { value: "9", sources: ["SZ"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 40,
      event: 41,
      seen: 30,
      ...g("2026-11-10", "next"),
      fields: { f2: { value: "3", sources: ["SY"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 50,
      event: 51,
      seen: 40,
      ...g("2026-11-01", "next"),
      fields: { f2: { value: "1", sources: ["SX"], explicit: false } },
      acknowledge: ["overwrite"],
    },
  ] as unknown as Op[];
  const HISTORIES: [string, string[][], Step[]][] = [
    ["B's list does not touch A's dropped block", [["S2"], ["S1"]], [{ c: 0 }, { c: 1 }]],
    [
      "the item brought back between A and B (A cancelled, then B)",
      [["S2"], ["SZ"]],
      [{ c: 0 }, { x: 0 }, { c: 1 }],
    ],
    ["B deletes the dropped item itself", [["S2"], ["SX"]], [{ c: 0 }, { c: 1 }]],
    ["B and C both clear it, A pending", [["S2"], ["SZ"], ["SY"]], [{ c: 0 }, { c: 1 }, { c: 2 }]],
    [
      "B and C both clear it, then A cancelled",
      [["S2"], ["SZ"], ["SY"]],
      [{ c: 0 }, { c: 1 }, { c: 2 }, { x: 0 }],
    ],
    [
      "B clears it, B cancelled, then C",
      [["S2"], ["SZ"], ["SY"]],
      [{ c: 0 }, { c: 1 }, { x: 1 }, { c: 2 }],
    ],
    ["B clears it, then A cancelled", [["S2"], ["SZ"]], [{ c: 0 }, { c: 1 }, { x: 0 }]],
    ["the order swapped: B first, then A", [["S2"], ["SZ"]], [{ c: 1 }, { c: 0 }]],
  ];
  for (const [name, dels, script] of HISTORIES) {
    it(name, () => {
      const r = againstReference(STATE_SCHEMA, OPS, dels, script);
      expect(r.fromEmpty).toEqual(r.reference);
    });
  }
});

describe("a block resting on a carried item, the only deletion on the row", () => {
  it("event table: a take's block, the item it carries restated as dropped", () => {
    // #20 writes f2 = 5; #50, stale, writes f2 = 1 (a candidate); #53 revokes the row; #60 writes
    // f2 = 1 (a candidate on existence); #63 takes #60's candidate: it restores the row and carries
    // #60's f2. Deleting #20's words puts #50 into effect and restates #60 as dropped (the same
    // value, no evidence); #63's f2 block rests on #60 by the carried item only (an event table's
    // block has no deps), and is cleared. With no other deletion on the row the delete operation
    // passes no list of its own (`cleared`): rule 2 alone, by the carried item, restates #63's f2.
    // Found by the property with that branch taken away (seed 646220842), then shrunk.
    const ops = [
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        fields: { f2: { value: "5", sources: ["S20"] } },
        acknowledge: ["overwrite"],
        seenCurrent: true,
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 10,
        fields: { f2: { value: "1", sources: ["S1", "S4"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      { kind: "revoke", op: 53, event: 54, seen: 52 },
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 50,
        fields: { f2: { value: "1", sources: ["S6"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "resolve",
        op: 63,
        event: 64,
        decision: "take_candidate",
        candidates: [61],
        unit: "existence",
        take: 61,
      },
    ] as unknown as Op[];
    const s = runScript(EVENT_SCHEMA, ops, [], [["S20"]], [{ c: 0 }]);
    expect(s.deletions.size).toBe(1);
    expect(
      s.log[0]?.restated.map((r) => `${r.item.event}/${r.item.target}/${r.item.k} ${r.status}`),
    ).toEqual(["51/f2/0 applied", "61/f2/0 dropped", "64/f2/0 applied"]);
    expect(s.fromEmpty()).toEqual(s.liveItems());
  });
});
