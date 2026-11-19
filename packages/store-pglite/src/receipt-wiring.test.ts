// What a write's receipt says beyond its outcome (04-contract §5.4, 04-contract-types `Warning` and
// `FieldResult`): the warnings the pipeline gives and the parts of applied fields. Fictional IDs
// and names.

import {
  createOpsContext,
  createTenant,
  pending,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"9".repeat(26)}`;
const USER = `u_${"2".repeat(26)}`;
/** Another writer. */
const OTHER = `ci_${"6".repeat(26)}`;

let s: ReusableStore;
let minute = 0;
const at = () => `2026-11-05T04:${String(++minute % 60).padStart(2, "0")}:00.000Z`;
const ctxOf = (actor: string, now = at()) =>
  createOpsContext({
    tenant: TENANT,
    actor,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now,
    confirmation: null,
  } as never);

const field = (name: string, required?: true) => ({
  name,
  type: name === "date" ? "date" : "text",
  description: name,
  ...(required ? { required } : {}),
});

beforeAll(async () => {
  s = await openReusable("saveslot-receipt-wiring-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  minute = 0;
  await s.reset();
  await createTenant(s.store, ctxOf(USER));
  await schemaDraft(s.store, ctxOf(USER), {
    document: {
      slot: "home",
      base_version: null,
      timezone: "Asia/Shanghai",
      tables: [
        {
          name: "rows",
          kind: "base",
          description: "rows",
          time: { type: "none" },
          fields: [field("b", true), field("c")],
        },
        {
          name: "entities",
          kind: "base",
          description: "entities",
          time: { type: "state", granularity: "date" },
          fields: [field("b", true), field("c")],
        },
        {
          name: "keyed",
          kind: "base",
          description: "entities written by key",
          time: { type: "state", granularity: "date" },
          fields: [field("k", true), field("b", true), field("c")],
          entity_key: ["k"],
        },
        {
          name: "moments",
          kind: "base",
          description: "entities on instants",
          time: { type: "state", granularity: "instant" },
          fields: [field("b", true), field("c")],
        },
      ],
    },
  } as never);
}, T);

// biome-ignore lint/suspicious/noExplicitAny: receipts as the contract gives them
type Any = any;
const put = (
  table: string,
  op: Record<string, unknown>,
  actor = USER,
  now?: string,
): Promise<Any> => write(s.store, ctxOf(actor, now), { sv: 1, ops: [{ table, ...op }] } as never);
const codes = (r: Any) => ((r.warnings ?? []) as Any[]).map((w) => w.code);

describe("clock_behind_log", () => {
  it(
    "an entry time earlier than the log's end: the log's end is recorded, and the receipt says by how much",
    async () => {
      const first = await put("rows", { intent: "insert", set: { b: "b0" } });
      expect(codes(first)).not.toContain("clock_behind_log");
      // An hour and a half second earlier than the last event's time (04:0x:00).
      const late = await put(
        "rows",
        { intent: "insert", set: { b: "b1" } },
        USER,
        "2026-11-05T02:59:59.500Z",
      );
      const w = (late.warnings as Any[]).find((x) => x.code === "clock_behind_log");
      const end = Date.parse(`2026-11-05T04:${String(minute).padStart(2, "0")}:00.000Z`);
      expect(w).toEqual({
        code: "clock_behind_log",
        behind_seconds: Math.ceil((end - Date.parse("2026-11-05T02:59:59.500Z")) / 1000),
      });
      // The operation is recorded at the log's end, not at the entry time.
      const recorded = await s.store.read((tx) =>
        tx.query<{ at: string }>("SELECT at FROM events WHERE seq = $1", [late.seq]),
      );
      expect(Date.parse(recorded.rows[0]?.at as string)).toBe(end);
    },
    T,
  );
});

describe("applied parts with merged: true", () => {
  const verAt = (r: Any) => r.ops[0].ver as string;
  const parts = (r: Any, f: string) => r.ops[0].fields[f] as Any[];

  it(
    "a stale ver: the field another changed since is a candidate, the field no one touched is applied and merged",
    async () => {
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0", c: "c0" },
      });
      const entity = e.ops[0].target.entity as string;
      await put("entities", { entity, intent: "update", ver: verAt(e), set: { c: "c1" } }, OTHER);
      const w = await put("entities", {
        entity,
        intent: "update",
        ver: verAt(e),
        set: { b: "b2", c: "c2" },
      });
      expect(parts(w, "b").map((x) => [x.result, x.merged])).toEqual([["applied", true]]);
      expect(parts(w, "c").map((x) => [x.result, x.merged])).toEqual([["candidate", undefined]]);
      // A replay rebuilds the receipt from the log: the same merged part.
      const again = await write(s.store, ctxOf(USER), {
        sv: 1,
        ops: [
          { table: "entities", entity, intent: "update", ver: verAt(e), set: { b: "b2", c: "c2" } },
        ],
        idempotency_key: "merge-1",
      } as never);
      const replay = await write(s.store, ctxOf(USER), {
        sv: 1,
        ops: [
          { table: "entities", entity, intent: "update", ver: verAt(e), set: { b: "b2", c: "c2" } },
        ],
        idempotency_key: "merge-1",
      } as never);
      expect((again as Any).ops[0].fields.b[0].merged).toBe(true);
      expect((replay as Any).replayed).toBe(true);
      expect((replay as Any).ops[0].fields.b).toEqual((again as Any).ops[0].fields.b);
    },
    T,
  );

  it(
    "the same field changed since, but on a stretch the write does not touch: applied and merged",
    async () => {
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0" },
      });
      const entity = e.ops[0].target.entity as string;
      await put(
        "entities",
        { entity, intent: "update", ver: verAt(e), valid_from: "2026-11-20", set: { b: "b1" } },
        OTHER,
      );
      const w = await put("entities", {
        entity,
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-01",
        valid_to: "2026-11-10",
        set: { b: "b2" },
      });
      expect(parts(w, "b").map((x) => [x.result, x.merged])).toEqual([["applied", true]]);
    },
    T,
  );

  it(
    "the row's current ver: applied, not merged; a timeless row with a stale ver: merged",
    async () => {
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0" },
      });
      const entity = e.ops[0].target.entity as string;
      const w = await put("entities", {
        entity,
        intent: "update",
        ver: verAt(e),
        set: { b: "b1" },
      });
      expect(parts(w, "b").map((x) => [x.result, x.merged])).toEqual([["applied", undefined]]);

      const r = await put("rows", { intent: "insert", set: { b: "b0", c: "c0" } });
      const row = r.ops[0].target.row as string;
      await put("rows", { row, intent: "update", ver: verAt(r), set: { c: "c1" } }, OTHER);
      const x = await put("rows", { row, intent: "update", ver: verAt(r), set: { b: "b2" } });
      expect([x.ops[0].fields.b.result, x.ops[0].fields.b.merged]).toEqual(["applied", true]);
    },
    T,
  );
});

describe("evidence_unreferenced", () => {
  const send = (body: Record<string, unknown>): Promise<Any> =>
    write(s.store, ctxOf(USER), { sv: 1, ...body } as never);
  const EVIDENCE = [
    { kind: "user_message", text: "it is b1" },
    { kind: "agent_note", text: "noted" },
    { kind: "user_message", text: "and c1" },
  ];

  it(
    "segments no op cites are named; an op citing none cites every segment",
    async () => {
      const some = await send({
        evidence: EVIDENCE,
        ops: [
          { table: "rows", intent: "insert", evidence_refs: [0], set: { b: "b1" } },
          { table: "rows", intent: "insert", evidence_refs: [0, 2], set: { b: "b2", c: "c1" } },
        ],
      });
      expect((some.warnings as Any[]).filter((w) => w.code === "evidence_unreferenced")).toEqual([
        { code: "evidence_unreferenced", evidence: [1] },
      ]);
      const all = await send({
        evidence: EVIDENCE,
        ops: [
          { table: "rows", intent: "insert", evidence_refs: [1], set: { b: "b3" } },
          { table: "rows", intent: "insert", set: { b: "b4" } },
        ],
      });
      expect(codes(all)).not.toContain("evidence_unreferenced");
      const none = await send({ ops: [{ table: "rows", intent: "insert", set: { b: "b5" } }] });
      expect(codes(none)).not.toContain("evidence_unreferenced");
    },
    T,
  );
});

describe("filled_gaps, once per stretch", () => {
  it(
    "a write of two fields across a revoked stretch: one gap in the receipt and in the item's details",
    async () => {
      const verAt = (r: Any) => r.ops[0].ver as string;
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0", c: "c0" },
      });
      const entity = e.ops[0].target.entity as string;
      const v = await put("entities", {
        entity,
        intent: "revoke",
        ver: verAt(e),
        valid_from: "2026-11-15",
        valid_to: "2026-11-21",
      });
      const w = await put("entities", {
        entity,
        intent: "update",
        ver: verAt(v),
        valid_from: "2026-11-12",
        valid_to: "2026-11-25",
        set: { b: "b1", c: "c1" },
      });
      expect(w.status).toBe("pending");
      const gap = {
        valid: {
          valid_from: "2026-11-15",
          valid_to: "2026-11-21",
          valid_to_inclusive: "2026-11-20",
        },
        revoked_by: v.seq,
      };
      for (const f of ["b", "c"]) {
        expect(w.ops[0].fields[f][0].impact.filled_gaps).toEqual([gap]);
      }
      const item = w.pending[0].id as string;
      const d = (await pending(s.store, ctxOf(USER), { id: item } as never)) as Any;
      expect(d.impact.filled_gaps).toEqual([gap]);
    },
    T,
  );
});

describe("a replayed receipt", () => {
  it(
    "gives no warnings: they are not in the log, and a replay rebuilds what the log has",
    async () => {
      const body = {
        sv: 1,
        evidence: [
          { kind: "user_message", text: "b6" },
          { kind: "agent_note", text: "not cited" },
        ],
        ops: [{ table: "rows", intent: "insert", evidence_refs: [0], set: { b: "b6" } }],
        idempotency_key: "replay-warnings",
      };
      const first = (await write(s.store, ctxOf(USER), body as never)) as Any;
      expect(codes(first)).toContain("evidence_unreferenced");
      const again = (await write(s.store, ctxOf(USER), body as never)) as Any;
      expect(again.replayed).toBe(true);
      expect(again.warnings).toBeUndefined();
    },
    T,
  );
});

describe("resolved: how each field's interval was given and came out", () => {
  const verAt = (r: Any) => r.ops[0].ver as string;
  const resolvedOf = (r: Any) => r.ops[0].resolved as Record<string, Any> | undefined;
  const entityOf = (r: Any) => r.ops[0].target.entity as string;
  const day = (from: string, to: string | null) => ({
    valid_from: from,
    valid_to: to,
    ...(to !== null
      ? {
          valid_to_inclusive: new Date(Date.parse(`${to}T00:00:00Z`) - 86_400_000)
            .toISOString()
            .slice(0, 10),
        }
      : {}),
  });

  it(
    "a default end meeting a change: next_change, the value from there on, which the write left",
    async () => {
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0" },
      });
      const entity = entityOf(e);
      const later = await put("entities", {
        entity,
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-10",
        set: { b: "b1" },
      });
      const w = await put("entities", {
        entity,
        intent: "update",
        ver: verAt(later),
        valid_from: "2026-11-02",
        set: { b: "b2" },
      });
      expect(resolvedOf(w)).toEqual({
        b: {
          ...day("2026-11-02", "2026-11-10"),
          from_as: "given",
          to_as: "next_change",
          next_change: { at: "2026-11-10", value: "b1" },
        },
      });
    },
    T,
  );

  it(
    "a default end with no change after it: lasting, so no next_change key",
    async () => {
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0" },
      });
      const w = await put("entities", {
        entity: entityOf(e),
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-05",
        set: { b: "b1" },
      });
      expect(resolvedOf(w)).toEqual({
        b: { ...day("2026-11-05", null), from_as: "given", to_as: "next_change" },
      });
    },
    T,
  );

  it(
    "an explicit end: given, no next_change",
    async () => {
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0" },
      });
      const w = await put("entities", {
        entity: entityOf(e),
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-05",
        valid_to: "2026-11-08",
        set: { b: "b1" },
      });
      expect(resolvedOf(w)).toEqual({
        b: { ...day("2026-11-05", "2026-11-08"), from_as: "given", to_as: "given" },
      });
    },
    T,
  );

  it(
    "a correction with neither end: corrected_span both ways, the stretch holding now",
    async () => {
      // `now` is 2026-11-05 (the context's clock): the stretch [11-01, 11-10) holds it.
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0" },
      });
      const later = await put("entities", {
        entity: entityOf(e),
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-10",
        set: { b: "b1" },
      });
      const w = await put("entities", {
        entity: entityOf(e),
        intent: "correct",
        ver: verAt(later),
        set: { b: "b0x" },
      });
      expect(resolvedOf(w)).toEqual({
        b: {
          ...day("2026-11-01", "2026-11-10"),
          from_as: "corrected_span",
          to_as: "corrected_span",
        },
      });
    },
    T,
  );

  it(
    "a write filling a revoked stretch: filled names it; the revoke's own resolved is for existence",
    async () => {
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0", c: "c0" },
      });
      const entity = entityOf(e);
      const v = await put("entities", {
        entity,
        intent: "revoke",
        ver: verAt(e),
        valid_from: "2026-11-05",
        valid_to: "2026-11-10",
      });
      expect(resolvedOf(v)).toEqual({
        "*": { ...day("2026-11-05", "2026-11-10"), from_as: "given", to_as: "given" },
      });
      const w = await put("entities", {
        entity,
        intent: "update",
        ver: verAt(v),
        valid_from: "2026-11-05",
        valid_to: "2026-11-10",
        set: { b: "b1", c: "c1" },
      });
      expect(w.status).toBe("saved");
      for (const f of ["b", "c"]) {
        expect(resolvedOf(w)?.[f]?.filled).toEqual([day("2026-11-05", "2026-11-10")]);
      }
    },
    T,
  );

  it(
    "a replay gives the same resolved, word for word",
    async () => {
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0" },
      });
      const later = await put("entities", {
        entity: entityOf(e),
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-10",
        set: { b: "b1" },
      });
      const body = {
        sv: 1,
        ops: [
          {
            table: "entities",
            entity: entityOf(e),
            intent: "update",
            ver: verAt(later),
            valid_from: "2026-11-02",
            set: { b: "b2" },
          },
        ],
        idempotency_key: "resolved-1",
      };
      const first = (await write(s.store, ctxOf(USER), body as never)) as Any;
      const again = (await write(s.store, ctxOf(USER), body as never)) as Any;
      expect(again.replayed).toBe(true);
      expect(resolvedOf(first)?.["b"]?.next_change).toBeDefined();
      expect(resolvedOf(again)).toEqual(resolvedOf(first));
    },
    T,
  );

  it(
    "a field with no change (a no-op) has no resolved: the log keeps only its name",
    async () => {
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0", c: "c0" },
      });
      const w = await put("entities", {
        entity: entityOf(e),
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-05",
        set: { b: "b0", c: "c1" },
      });
      expect(w.ops[0].fields.b).toEqual([{ result: "noop" }]);
      expect(Object.keys(resolvedOf(w) ?? {})).toEqual(["c"]);
    },
    T,
  );

  it(
    "an undo has no resolved: its interval comes from its write-backs, not from parameters",
    async () => {
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0" },
      });
      const w = await put("entities", {
        entity: entityOf(e),
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-05",
        set: { b: "b1" },
      });
      const u = await put("entities", {
        entity: entityOf(e),
        revert: { undo: w.seq },
        ver: verAt(w),
      });
      expect(u.ops[0].undo).toBeDefined();
      expect(resolvedOf(u)).toBeUndefined();
    },
    T,
  );
});

describe("resolved.filled: every stretch without a value the write fills, however it came to have none", () => {
  const verAt = (r: Any) => r.ops[0].ver as string;
  const resolvedOf = (r: Any) => r.ops[0].resolved as Record<string, Any> | undefined;
  const entityOf = (r: Any) => r.ops[0].target.entity as string;
  const dayBefore = (to: string) =>
    new Date(Date.parse(`${to}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const span = (from: string, to: string | null) => ({
    valid_from: from,
    valid_to: to,
    ...(to !== null ? { valid_to_inclusive: dayBefore(to) } : {}),
  });

  it(
    "before the entity's first stretch: filled",
    async () => {
      // The entity has a value from 11-05; [11-01, 11-05) is before its first stretch (05-time
      // «无值区间»): writing it there fills it.
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-05",
        set: { b: "b0" },
      });
      const w = await put("entities", {
        entity: entityOf(e),
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-01",
        valid_to: "2026-11-05",
        set: { b: "b1" },
      });
      expect(w.status).toBe("saved");
      expect(resolvedOf(w)?.["b"]?.filled).toEqual([span("2026-11-01", "2026-11-05")]);
    },
    T,
  );

  it(
    "after an explicit end, to a given end or lasting: filled",
    async () => {
      // The entity has a value on [11-01, 11-05) only (an explicit end): after 11-05 it has none.
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        valid_to: "2026-11-05",
        set: { b: "b0" },
      });
      const w = await put("entities", {
        entity: entityOf(e),
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-08",
        valid_to: "2026-11-12",
        set: { b: "b1" },
      });
      expect(resolvedOf(w)?.["b"]?.filled).toEqual([span("2026-11-08", "2026-11-12")]);
      // From 11-20 on, open: [11-20, ∞) had no value either.
      const x = await put("entities", {
        entity: entityOf(e),
        intent: "update",
        ver: verAt(w),
        valid_from: "2026-11-20",
        valid_to: "open",
        set: { b: "b2" },
      });
      expect(resolvedOf(x)?.["b"]).toMatchObject({
        to_as: "open",
        filled: [span("2026-11-20", null)],
      });
    },
    T,
  );

  it(
    "a revoke's hole next to a stretch never written: one stretch filled",
    async () => {
      // b0 on [11-01, 11-10) (an explicit end), the stretch [11-05, 11-10) revoked: no value from
      // 11-05 on, a revoke's hole up to 11-10 and never written after it. A write over [11-05,
      // 11-15) fills both, side by side: one stretch.
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        valid_to: "2026-11-10",
        set: { b: "b0" },
      });
      const v = await put("entities", {
        entity: entityOf(e),
        intent: "revoke",
        ver: verAt(e),
        valid_from: "2026-11-05",
        valid_to: "2026-11-10",
      });
      const w = await put("entities", {
        entity: entityOf(e),
        intent: "update",
        ver: verAt(v),
        valid_from: "2026-11-05",
        valid_to: "2026-11-15",
        set: { b: "b1" },
      });
      expect(w.status).toBe("saved");
      expect(resolvedOf(w)?.["b"]?.filled).toEqual([span("2026-11-05", "2026-11-15")]);
    },
    T,
  );

  it(
    "a write that awaits fills nothing yet: no filled; its impact names the stretch it would fill",
    async () => {
      // b0 from 11-05; b1 from 11-10; then b2 over [11-01, 11-15): it would erase the change point
      // at 11-10, so it awaits (high impact). [11-01, 11-05) is before the entity's first stretch:
      // the write would fill it on confirmation, nothing is filled now. No revoke left it so: the
      // gap has no revoked_by.
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-05",
        set: { b: "b0" },
      });
      const later = await put("entities", {
        entity: entityOf(e),
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-10",
        set: { b: "b1" },
      });
      const w = await put("entities", {
        entity: entityOf(e),
        intent: "update",
        ver: verAt(later),
        valid_from: "2026-11-01",
        valid_to: "2026-11-15",
        set: { b: "b2" },
      });
      expect(w.status).toBe("pending");
      expect(resolvedOf(w)?.["b"]).not.toHaveProperty("filled");
      const gap = [{ valid: span("2026-11-01", "2026-11-05") }];
      expect(w.ops[0].fields.b[0].impact.filled_gaps).toEqual(gap);
      const d = (await pending(s.store, ctxOf(USER), { id: w.pending[0].id } as never)) as Any;
      expect(d.impact.filled_gaps).toEqual(gap);
    },
    T,
  );

  // One request, several ops on one entity: the ops before an op in the same request count as
  // applied (04-contract §4 «无值区间»). The version table keeps only the row the whole operation
  // left, so these are the cases a reading of it right before the operation gets wrong.
  const many = (ops: Record<string, unknown>[]): Promise<Any> =>
    write(s.store, ctxOf(USER), { sv: 1, ops } as never);

  it(
    "an entity an earlier op of the request created: a value where that op gave one, a gap after it",
    async () => {
      // op 0 creates the entity, b0 on [11-05, 11-10). op 1 writes c on [11-07, 11-09): the entity
      // has a value there (op 0's), nothing is filled. op 2 writes b on [11-12, 11-15), after op
      // 0's explicit end: no value there, filled (op 2 did not create the entity: it fills).
      const r = await many([
        {
          table: "keyed",
          intent: "update",
          entity_key: { k: "x" },
          valid_from: "2026-11-05",
          valid_to: "2026-11-10",
          set: { b: "b0" },
        },
        {
          table: "keyed",
          intent: "update",
          entity_key: { k: "x" },
          valid_from: "2026-11-07",
          valid_to: "2026-11-09",
          set: { c: "c1" },
        },
        {
          table: "keyed",
          intent: "update",
          entity_key: { k: "x" },
          valid_from: "2026-11-12",
          valid_to: "2026-11-15",
          set: { b: "b1" },
        },
      ]);
      expect(r.status).toBe("saved");
      expect(r.ops[0].created_entity).toBe(true);
      expect(r.ops[1].target.entity).toBe(r.ops[0].target.entity);
      expect(r.ops[1].resolved).toEqual({
        c: { ...span("2026-11-07", "2026-11-09"), from_as: "given", to_as: "given" },
      });
      expect(r.ops[2].resolved.b.filled).toEqual([span("2026-11-12", "2026-11-15")]);
      expect(r.ops[2].resolved.k.filled).toEqual([span("2026-11-12", "2026-11-15")]);
    },
    T,
  );

  it(
    "a gap an earlier op of the request filled: no longer a gap; the stretch after its end still is",
    async () => {
      // b0 on [11-01, 11-05) only. op 0 fills [11-08, 11-12) with b1. op 1 writes c on [11-09,
      // 11-11), inside what op 0 filled: nothing. op 2 writes b on [11-12, 11-15), right after op
      // 0's explicit end: [11-12, 11-15) had no value, filled.
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        valid_to: "2026-11-05",
        set: { b: "b0" },
      });
      const entity = entityOf(e);
      const r = await many([
        {
          table: "entities",
          entity,
          intent: "update",
          ver: verAt(e),
          valid_from: "2026-11-08",
          valid_to: "2026-11-12",
          set: { b: "b1" },
        },
        {
          table: "entities",
          entity,
          intent: "update",
          valid_from: "2026-11-09",
          valid_to: "2026-11-11",
          set: { c: "c1" },
        },
        {
          table: "entities",
          entity,
          intent: "update",
          valid_from: "2026-11-12",
          valid_to: "2026-11-15",
          set: { b: "b2" },
        },
      ]);
      expect(r.status).toBe("saved");
      expect(r.ops[0].resolved.b.filled).toEqual([span("2026-11-08", "2026-11-12")]);
      expect(r.ops[1].resolved.c).not.toHaveProperty("filled");
      expect(r.ops[2].resolved.b.filled).toEqual([span("2026-11-12", "2026-11-15")]);
    },
    T,
  );

  it(
    "a hole an earlier op of the request left: filled",
    async () => {
      // b0 from 11-01 on. op 0 revokes [11-03, 11-05); op 1 writes b there: it fills the hole op 0
      // left, though the entity had a value there before the request.
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0" },
      });
      const entity = entityOf(e);
      const r = await many([
        {
          table: "entities",
          entity,
          intent: "revoke",
          ver: verAt(e),
          valid_from: "2026-11-03",
          valid_to: "2026-11-05",
        },
        {
          table: "entities",
          entity,
          intent: "update",
          valid_from: "2026-11-03",
          valid_to: "2026-11-05",
          set: { b: "b1" },
        },
      ]);
      expect(r.status).toBe("saved");
      expect(r.ops[1].resolved.b.filled).toEqual([span("2026-11-03", "2026-11-05")]);
    },
    T,
  );

  it(
    "on an instant table: next_change and filled write instants as the interval does",
    async () => {
      // Instants given with an offset come out in UTC with milliseconds (04-contract-types «时刻»):
      // the interval, next_change's at and filled alike.
      const e = await put("moments", {
        intent: "insert",
        valid_from: "2026-11-05T00:00:00+08:00",
        set: { b: "b0" },
      });
      const later = await put("moments", {
        entity: entityOf(e),
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-10T08:30:00+08:00",
        set: { b: "b1" },
      });
      const w = await put("moments", {
        entity: entityOf(e),
        intent: "update",
        ver: verAt(later),
        valid_from: "2026-11-06T10:00:00+08:00",
        set: { b: "b2" },
      });
      expect(resolvedOf(w)).toEqual({
        b: {
          valid_from: "2026-11-06T02:00:00.000Z",
          valid_to: "2026-11-10T00:30:00.000Z",
          from_as: "given",
          to_as: "next_change",
          next_change: { at: "2026-11-10T00:30:00.000Z", value: "b1" },
        },
      });
      // Before the entity's first stretch (11-05 00:00 +08:00 = 11-04 16:00 Z): filled.
      const x = await put("moments", {
        entity: entityOf(e),
        intent: "update",
        ver: verAt(w),
        valid_from: "2026-11-04T12:00:00+08:00",
        valid_to: "2026-11-05T00:00:00+08:00",
        set: { b: "b3" },
      });
      expect(resolvedOf(x)?.["b"]?.filled).toEqual([
        { valid_from: "2026-11-04T04:00:00.000Z", valid_to: "2026-11-04T16:00:00.000Z" },
      ]);
    },
    T,
  );

  it(
    "an entity this write creates has no filled: there was nothing to fill",
    async () => {
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        valid_to: "2026-11-05",
        set: { b: "b0" },
      });
      expect(resolvedOf(e)?.["b"]).toEqual({
        ...span("2026-11-01", "2026-11-05"),
        from_as: "given",
        to_as: "given",
      });
    },
    T,
  );
});
