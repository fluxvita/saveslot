// Fixed cases of the record mapping for what the comparison's scenarios do not reach: conflict
// groups and several ops of one request (09-event-format §5.7).

import type {
  BizPoint,
  EntityId,
  FieldId,
  ItemId,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { parseEvent } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { judgeOp, replay, stateFromRecord } from "../judge/judge.ts";
import type { JudgeInput, TableShape } from "../judge/model.ts";
import { decodeRecords, encodeOp, type RowContext, type StoredEvent } from "./record.ts";

const HASH = "a".repeat(64);
const CONN = `ci_${"2".repeat(26)}`;
const SLOT = `sl_${"4".repeat(16)}`;
const ENTITY = `e_${"7".repeat(26)}` as EntityId;
const ITEM = `pi_${"8".repeat(16)}` as ItemId;
const AT = "2026-11-10T04:41:07.123Z";
const d = (md: string) => `2026-${md}` as BizPoint;

const GROUPED: TableShape = {
  kind: "state",
  fields: ["f4", "f5"],
  valued: ["f4"],
  required: ["f4"],
  groups: [["f4", "f5"]],
};

const ctxOf = (shape: TableShape): RowContext => ({
  table: "t1" as TableId,
  target: { entity: ENTITY },
  shape,
  granularity: "date",
});

function write(
  op: number,
  fields: Record<string, string>,
  from: string,
  o: { seen?: number; index?: number; ack?: boolean } = {},
): JudgeInput {
  const index = o.index ?? 0;
  return {
    kind: "write",
    op,
    index,
    event: op + 1 + index,
    ruleset: 1,
    seen: o.seen ?? op - 1,
    seenExplicit: o.seen !== undefined,
    valid: { from: { mode: "given", value: d(from) }, to: { mode: "open" } },
    now: d("11-05"),
    fields: Object.fromEntries(
      Object.entries(fields).map(([f, v]) => [f, { value: v }]),
    ) as Partial<Record<FieldId, { value: string }>>,
    ...(o.ack ? { acknowledge: true } : {}),
  };
}

const header = (type: string, seq: number, op?: number) => ({
  type,
  v: 1,
  seq,
  at: AT,
  prev_hash: HASH,
  actor: CONN,
  slot: SLOT,
  ...(op !== undefined ? { op } : {}),
});
const ctxBlock = {
  now: "2026-11-05T00:00:00.000Z",
  today: "2026-11-05",
  ruleset_version: 1,
  policy_version: 1,
  literal_checker: "literal@1",
};

/** Encodes judged ops; ops of one request share one write.head. */
function events(ctx: RowContext, inputs: readonly JudgeInput[]): StoredEvent[] {
  const { judgements } = replay(ctx.shape, inputs);
  const heads = new Map<number, Record<string, unknown>>();
  const out: StoredEvent[] = [];
  let item = 0;
  judgements.forEach((j, n) => {
    const input = inputs[n] as JudgeInput;
    const enc = encodeOp(ctx, input, j, {
      intent: n === 0 ? "insert" : "update",
      ...(j.created ? { created: true as const } : {}),
      sv: 1,
      sources: [input.op],
      raw:
        input.kind === "write"
          ? Object.fromEntries(Object.entries(input.fields).map(([f, x]) => [f, x?.value ?? null]))
          : {},
      restoreCount: 0,
      conflictItems: j.conflicts.map(() => ({
        item: `pi_${String(++item).padStart(16, "0")}` as ItemId,
        candidate: 0,
        mergeBase: input.kind === "write" ? input.seen : input.op - 1,
      })),
      awaitingItem: ITEM,
      versions: { ruleset: 1, policy: 1 },
    });
    heads.set(input.op, { ...(heads.get(input.op) ?? {}), ...enc.head });
    if (enc.base !== undefined) {
      out.push({
        header: { type: "write.base", seq: input.event, op: input.op },
        blocks: enc.base,
      });
    }
    enc.items.forEach((it, k) => {
      out.push({
        header: { type: it.type, seq: 1000 + input.event * 10 + k, op: input.op },
        blocks: it.blocks,
      });
    });
  });
  for (const [op, h] of heads) {
    const ops = new Set(Object.keys(h).map((p) => p.split("/")[1]));
    out.push({
      header: { type: "write.head", seq: op },
      blocks: { ctx: ctxBlock, request: { sv: 1, sv_basis: "explicit", op_count: ops.size }, ...h },
    });
  }
  for (const e of out) {
    const p = parseEvent(header(e.header.type, e.header.seq, e.header.op), e.blocks);
    expect({ seq: e.header.seq, p }).toEqual({
      seq: e.header.seq,
      p: { ok: true, type: e.header.type },
    });
  }
  return out;
}

describe("the record mapping", () => {
  it("a no-op field beside a change: its raw value is not kept, the record's no-op list is", () => {
    const ctx = ctxOf({ ...GROUPED, groups: [] });
    const inputs = [
      write(10, { f4: "1", f5: "a" }, "10-01", {}),
      write(20, { f4: "2", f5: "a" }, "10-01", { seen: 10, ack: true }),
    ];
    const { state } = replay(ctx.shape, inputs);
    const r = state.records[1];
    expect(r?.kind === "write" ? r.noop : []).toEqual(["f5"]);
    const evs = events(ctx, inputs);
    const head = evs.find((e) => e.header.type === "write.head" && e.header.seq === 20);
    expect(head?.blocks["ops/0/noop"]).toEqual(["f5"]);
    expect(head?.blocks["ops/0/set/f5"]).toBeUndefined();
    expect(decodeRecords(ctx, evs)).toEqual(state.records);
  });

  it("corrected_span: recorded as both ends corrected_span, read back as corrected_span", () => {
    const ctx = ctxOf({ ...GROUPED, groups: [] });
    const correct: JudgeInput = {
      ...write(20, { f4: "2" }, "10-01", { seen: 10 }),
      valid: "corrected_span",
    } as JudgeInput;
    const inputs = [write(10, { f4: "1" }, "10-01", {}), correct];
    const { state } = replay(ctx.shape, inputs);
    const evs = events(ctx, inputs);
    const head = evs.find((e) => e.header.type === "write.head" && e.header.seq === 20);
    expect(head?.blocks["ops/0/valid"]).toEqual({
      from: { mode: "corrected_span" },
      to: { mode: "corrected_span" },
    });
    expect(decodeRecords(ctx, evs)).toEqual(state.records);
  });

  it("a conflict group: one candidate over both fields, back to the same records", () => {
    const ctx = ctxOf(GROUPED);
    const inputs = [
      write(10, { f4: "1", f5: "a" }, "10-01", {}),
      write(20, { f4: "2" }, "11-01", { ack: true }),
      write(30, { f4: "3", f5: "b" }, "11-03", { seen: 10 }),
    ];
    const { state } = replay(GROUPED, inputs);
    const evs = events(ctx, inputs);
    const created = evs.find((e) => e.header.type === "item.created");
    expect(created?.blocks["target"]).toMatchObject({ unit: ["f4", "f5"] });
    expect(decodeRecords(ctx, evs)).toEqual(state.records);
  });

  it("several ops of one request: one write.head, a write.base each, judged as written", () => {
    const ctx = ctxOf({ ...GROUPED, groups: [] });
    const inputs = [
      write(10, { f4: "1" }, "10-01", {}),
      write(20, { f4: "2" }, "11-01", { seen: 10, index: 0 }),
      write(20, { f5: "x" }, "11-05", { seen: 10, index: 1 }),
    ];
    const { state } = replay(ctx.shape, inputs);
    const evs = events(ctx, inputs);
    const head = evs.find((e) => e.header.type === "write.head" && e.header.seq === 20);
    expect(Object.keys(head?.blocks ?? {}).filter((p) => p.endsWith("/target"))).toEqual([
      "ops/0/target",
      "ops/1/target",
    ]);
    const decoded = decodeRecords(ctx, evs);
    expect(decoded).toEqual(state.records);
    // The next op judged on the rebuilt state gets the same judgement.
    const next = write(30, { f4: "3" }, "11-03", { seen: 20, ack: true });
    expect(judgeOp(stateFromRecord(ctx.shape, decoded), next)).toEqual(judgeOp(state, next));
  });
});
