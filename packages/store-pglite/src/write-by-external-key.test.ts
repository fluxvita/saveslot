// Writes by external key through the write path (03-data-model/04-write-and-read.md «按来源键写入»;
// 04-contract §5.1, §5.4, §14; 09-event-format §4.2, §5.6, §5.7): locating by the key index, each
// outcome with its receipt and events, the ops that enter no event (no source, an empty index in
// `ops/<i>`, no event at all when none enters), the request key, the merge base of a candidate by
// unit, and a table whose key the current version no longer has.

import {
  catalog,
  createOpsContext,
  createTenant,
  readEvents,
  readTail,
  reconcileLog,
  resolve,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
// biome-ignore lint/suspicious/noExplicitAny: receipts and blocks read loosely in a test
type Any = any;

// `meals`: timeless, keyed by (origin, external_id); `energy` and `note` in one conflict group,
// `rating` alone.
const MEALS = {
  name: "meals",
  kind: "base",
  description: "a meal",
  time: { type: "none" },
  fields: [
    { name: "origin", type: "text", description: "the source system" },
    { name: "external_id", type: "text", description: "its ID there" },
    { name: "energy", type: "integer", description: "kcal" },
    { name: "note", type: "text", description: "a note" },
    { name: "rating", type: "integer", description: "1 to 5" },
  ],
  together: [["energy", "note"]],
  external_key: ["origin", "external_id"],
};
const DOCUMENT = { slot: "food", base_version: null, timezone: "Asia/Shanghai", tables: [MEALS] };

let s: ReusableStore;
let scratch: ReusableStore;
let minute = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" } as never,
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
const w = (params: unknown): Promise<Any> => write(s.store, ctx(), params);
async function refused(params: unknown) {
  try {
    await w(params);
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, ...x.detail };
  }
  return "accepted";
}
const tail = async () => (await s.store.read(readTail))?.seq ?? 0;
/** The events of operation `op`, by type, with their present blocks. */
const opEvents = (op: number) =>
  s.store.read(async (tx) => {
    const evs = await readEvents(tx, op, (await readTail(tx))?.seq ?? op);
    return evs
      .filter((e) => e.header["seq"] === op || e.header["op"] === op)
      .map((e) => ({
        type: e.header["type"] as string,
        blocks: Object.fromEntries(
          [...e.blocks].flatMap(([k, b]) => (b.state === "present" ? [[k, b.value]] : [])),
        ) as Record<string, Any>,
      }));
  });
const byKey = (id: string, set: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  intent: "update",
  table: "meals",
  external_key: { origin: "band_app", external_id: id },
  set,
  ...extra,
});
const rows = () =>
  s.store.read(
    async (tx) =>
      (await tx.query<{ n: unknown }>("SELECT count(*) AS n FROM external_keys")).rows[0]?.n,
  );

/**
 * The receipt against 04-contract-types §5.1 (`WriteResult`, `OpResult`, `TargetRef`) at run time:
 * keys the contract has, the required ones there, values of its enums. The kernel types three
 * receipts more narrowly than the contract (none of the ops in an event: no `seq`; a replay's op
 * that entered no event: `{ op_index }`; such an op's result: no `fields`) and casts there; this
 * checks the JSON itself, so a cast cannot hide a difference. Its lists are the contract's
 * (packages/contract/src/write.ts), which this package may not import.
 */
function contractIssues(r: Any): string[] {
  const out: string[] = [];
  const only = (x: Any, keys: readonly string[], at: string) => {
    for (const k of Object.keys(x))
      if (!keys.includes(k)) out.push(`${at}: ${k} not in the contract`);
  };
  const needs = (x: Any, keys: readonly string[], at: string) => {
    for (const k of keys) if (!Object.hasOwn(x, k)) out.push(`${at}: ${k} missing`);
  };
  const json = JSON.parse(JSON.stringify(r));
  if (JSON.stringify(json) !== JSON.stringify(r)) out.push("not plain JSON");
  only(
    json,
    [
      "status",
      "sv",
      "seq",
      "ops",
      "derived",
      "derived_total",
      "pending",
      "superseded",
      "affected_reads",
      "premise_affected",
      "external_key_summary",
      "replayed",
      "omitted",
      "original_deleted",
      "warnings",
      "notices",
    ],
    "result",
  );
  needs(
    json,
    ["status", "sv", "ops", "derived", "derived_total", "pending", "superseded"],
    "result",
  );
  if (!["saved", "pending"].includes(json.status)) out.push(`status ${json.status}`);
  if (json.seq !== undefined && !Number.isInteger(json.seq)) out.push("seq");
  for (const [i, o] of (json.ops as Any[]).entries()) {
    const at = `ops/${i}`;
    if (Object.keys(o).length === 1 && Number.isInteger(o.op_index)) continue;
    only(
      o,
      [
        "target",
        "as",
        "intent",
        "ver",
        "outcome",
        "skip_reason",
        "revoked_by",
        "deletion",
        "ref_op",
        "created_entity",
        "existing_keys",
        "similar_keys",
        "fields",
        "resolved",
        "undo",
        "premises",
        "premise_covered",
      ],
      at,
    );
    needs(o, ["target", "intent"], at);
    only(
      o.target ?? {},
      ["table", "row", "entity", "entity_key", "external_key", "key"],
      `${at}/target`,
    );
    if (
      o.outcome !== undefined &&
      !["created", "updated", "unchanged", "pending", "skipped"].includes(o.outcome)
    )
      out.push(`${at}: outcome ${o.outcome}`);
    if (
      o.skip_reason !== undefined &&
      !["revoked", "pending_deletion", "ref_skipped"].includes(o.skip_reason)
    )
      out.push(`${at}: skip_reason`);
    if (o.revoked_by !== undefined && !Number.isInteger(o.revoked_by))
      out.push(`${at}: revoked_by`);
    if ((o.outcome === "unchanged" || o.outcome === "skipped") && o.fields !== undefined)
      out.push(`${at}: fields on ${o.outcome}`);
  }
  for (const [i, o] of (json.ops as Any[]).entries()) {
    const at = `ops/${i}`;
    // An outcome's companions (04-contract-types §5.1): skipped with its reason (revoked: by what),
    // no ver; unchanged with its row's ver.
    if (o.outcome === "skipped") {
      if (o.skip_reason === undefined) out.push(`${at}: skipped without skip_reason`);
      if (o.skip_reason === "revoked" && !Number.isInteger(o.revoked_by))
        out.push(`${at}: revoked without revoked_by`);
      if (o.ver !== undefined) out.push(`${at}: ver on skipped`);
    } else if (o.skip_reason !== undefined || o.revoked_by !== undefined)
      out.push(`${at}: skip_reason without skipped`);
    if (o.outcome === "unchanged" && typeof o.ver !== "string")
      out.push(`${at}: unchanged without ver`);
    if (o.ver !== undefined && !/^v[0-9]+\.[0-9]+$/.test(o.ver)) out.push(`${at}: ver ${o.ver}`);
  }
  if (json.external_key_summary !== undefined) {
    const k = json.external_key_summary;
    only(k, ["created", "updated", "unchanged", "pending", "skipped"], "external_key_summary");
    needs(k, ["created", "updated", "pending"], "external_key_summary");
    for (const [name, n] of Object.entries(k)) {
      if (!Number.isInteger(n)) out.push(`external_key_summary.${name} not an integer`);
      // Its counts are the ops' outcomes (a replay's ops by index count for none).
      const counted = (json.ops as Any[]).filter((o) => o.outcome === name).length;
      if (n !== counted) out.push(`external_key_summary.${name} ${n}, the ops ${counted}`);
    }
  }
  // Warning codes: 04-contract-types §7 (packages/contract/src/common.ts WARNING_CODES).
  const codes = [
    "unit_converted",
    "rounded",
    "timezone_assumed",
    "time_truncated",
    "ver_fallback",
    "sv_fallback",
    "item_ver_fallback",
    "renamed",
    "multi_segment_unmapped",
    "evidence_unreferenced",
    "overwrote_corroborated",
    "pending_deletion_on_target",
    "clock_behind_log",
    "premise_ver_fallback",
    "premise_already_changed",
    "evidence_not_stored",
    "external_key_skipped",
    "external_key_resync",
    "single_field_external_key",
    "group_key_free_text",
  ];
  for (const x of json.warnings ?? []) {
    if (!codes.includes(x.code)) out.push(`warning ${x.code}`);
    if (x.code === "evidence_not_stored") {
      only(x, ["code", "evidence", "op_evidence"], "evidence_not_stored");
      if (!Array.isArray(x.evidence)) out.push("evidence_not_stored without evidence");
    }
    if (x.code === "external_key_skipped") {
      const skipped = (json.ops as Any[]).flatMap((o, i) => (o.outcome === "skipped" ? [i] : []));
      if (JSON.stringify(x.ops) !== JSON.stringify(skipped))
        out.push("external_key_skipped not the skipped ops");
    }
  }
  for (const v of json.omitted ?? []) {
    if (
      ![
        "affected_reads",
        "derived_values",
        "before_values",
        "skipped_spans",
        "deleted_content",
        "unrecorded_ops",
        "existing_keys",
        "field_results",
        "lists",
      ].includes(v)
    )
      out.push(`omitted ${v}`);
  }
  return out;
}

beforeAll(async () => {
  s = await openReusable("saveslot-write-by-key-");
  scratch = await openReusable("saveslot-write-by-key-scratch-");
}, T);
afterAll(async () => {
  await s?.close();
  await scratch?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  await scratch.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), { document: structuredClone(DOCUMENT) });
}, T);

describe("each outcome", () => {
  it(
    "created: a new row holding the key; its events: by_external_key, created, no ver",
    async () => {
      const r = await w({ sv: 1, ops: [byKey("m-1", { energy: 600 })] });
      expect(r).toMatchObject({
        status: "saved",
        external_key_summary: { created: 1, updated: 0, unchanged: 0, pending: 0, skipped: 0 },
      });
      expect(r.ops[0]).toMatchObject({
        outcome: "created",
        intent: "update",
        target: { table: "food.meals", external_key: { origin: "band_app", external_id: "m-1" } },
      });
      const head = (await opEvents(r.seq)).find((e) => e.type === "write.head")?.blocks as Any;
      expect(head["ops/0/target"]).toEqual({
        table: expect.any(String),
        row: r.ops[0].target.row,
        intent: "update",
        by_external_key: true,
        created: true,
      });
      expect(head["ops/0/set/f1"]).toBe("band_app");
      expect(Number(await rows())).toBe(1);
    },
    T,
  );

  it(
    "unchanged: the same contents again leave nothing — no event, no seq, the row's ver",
    async () => {
      const first = await w({ sv: 1, ops: [byKey("m-1", { energy: 600 })] });
      const before = await tail();
      const r = await w({ sv: 1, ops: [byKey("m-1", { energy: 600 })] });
      expect(await tail()).toBe(before);
      expect(r.seq).toBeUndefined();
      expect(r.ops[0]).toEqual({
        target: {
          table: "food.meals",
          row: first.ops[0].target.row,
          external_key: { origin: "band_app", external_id: "m-1" },
        },
        intent: "update",
        ver: first.ops[0].ver,
        outcome: "unchanged",
      });
      expect(r.external_key_summary).toEqual({
        created: 0,
        updated: 0,
        unchanged: 1,
        pending: 0,
        skipped: 0,
      });
      // No op in an event: the receipt as the contract has it (no seq).
      expect(contractIssues(r)).toEqual([]);
    },
    T,
  );

  it(
    "updated: a changed value applied; ver of basis external_key, the baseline, the key fields no-ops",
    async () => {
      const first = await w({ sv: 1, ops: [byKey("m-1", { energy: 600, rating: 3 })] });
      const r = await w({ sv: 1, ops: [byKey("m-1", { energy: 650, rating: 3 })] });
      expect(r.ops[0]).toMatchObject({ outcome: "updated" });
      const head = (await opEvents(r.seq)).find((e) => e.type === "write.head")?.blocks as Any;
      expect(head["ops/0/target"]).toEqual({
        table: expect.any(String),
        row: first.ops[0].target.row,
        intent: "update",
        by_external_key: true,
        ver: { op: first.seq, restore_count: 0, basis: "external_key" },
      });
      expect(head["ops/0/baseline"]).toEqual({ f3: first.seq });
      expect(head["ops/0/noop"]).toEqual(["f1", "f2", "f5"]);
      // The api_call: the op as sent, its no-op fields' values left out (09 §5.6).
      const api = (await opEvents(r.seq)).find((e) => e.type === "source.recorded")?.blocks as Any;
      expect(api["request"]).toMatchObject({
        external_key: { origin: "band_app", external_id: "m-1" },
        set: { energy: 650 },
        noop: ["rating"],
      });
    },
    T,
  );

  it(
    "pending: changed by the user, then by the source — a candidate, a conflict item",
    async () => {
      const first = await w({ sv: 1, ops: [byKey("m-1", { energy: 600 })] });
      const row = first.ops[0].target.row;
      await w({
        sv: 1,
        ops: [
          { intent: "update", table: "meals", row, ver: first.ops[0].ver, set: { energy: 500 } },
        ],
      });
      const r = await w({ sv: 1, ops: [byKey("m-1", { energy: 650 })] });
      expect(r.status).toBe("pending");
      expect(r.ops[0]).toMatchObject({ outcome: "pending" });
      expect(r.pending).toHaveLength(1);
    },
    T,
  );

  it(
    "skipped: the row revoked; nothing written, the revoke's operation given",
    async () => {
      const first = await w({ sv: 1, ops: [byKey("m-1", { energy: 600 })] });
      const row = first.ops[0].target.row;
      const rv = await w({
        sv: 1,
        ops: [{ intent: "revoke", table: "meals", row, ver: first.ops[0].ver }],
      });
      const before = await tail();
      const r = await w({ sv: 1, ops: [byKey("m-1", { energy: 650 })] });
      expect(await tail()).toBe(before);
      expect(r.ops[0]).toMatchObject({
        outcome: "skipped",
        skip_reason: "revoked",
        revoked_by: rv.seq,
      });
      expect(r.ops[0].fields).toBeUndefined();
      expect(r.warnings).toContainEqual({ code: "external_key_skipped", ops: [0] });
    },
    T,
  );

  it(
    "skipped by a revoke earlier in the same request: revoked_by is this request's operation",
    async () => {
      const first = await w({ sv: 1, ops: [byKey("m-1", { energy: 600 })] });
      const row = first.ops[0].target.row;
      const r = await w({
        sv: 1,
        ops: [
          { intent: "revoke", table: "meals", row, ver: first.ops[0].ver },
          byKey("m-1", { energy: 650 }),
        ],
      });
      expect(r.ops[1]).toMatchObject({ outcome: "skipped", revoked_by: r.seq });
      const head = (await opEvents(r.seq)).find((e) => e.type === "write.head")?.blocks as Any;
      expect(head["request"]).toMatchObject({ op_count: 2 });
      expect(head["ops/1/target"]).toBeUndefined();
    },
    T,
  );
});

describe("ops that enter no event", () => {
  it(
    "one unchanged, one updated: op_count 2, ops/0 left empty, one api_call; the receipt has both",
    async () => {
      await w({ sv: 1, ops: [byKey("m-1", { energy: 600 }), byKey("m-2", { energy: 300 })] });
      const r = await w({
        sv: 1,
        ops: [byKey("m-1", { energy: 600 }), byKey("m-2", { energy: 350 })],
      });
      const evs = await opEvents(r.seq);
      const head = evs.find((e) => e.type === "write.head")?.blocks as Any;
      expect(head["request"]).toMatchObject({ op_count: 2 });
      expect(head["ops/0/target"]).toBeUndefined();
      expect(head["ops/1/target"]).toMatchObject({ by_external_key: true });
      const apis = evs.filter((e) => e.type === "source.recorded");
      expect(apis.map((e) => e.blocks["target"].op_index)).toEqual([1]);
      expect(r.ops.map((x: Any) => x.outcome)).toEqual(["unchanged", "updated"]);
      expect(r.ops[0].fields).toBeUndefined();
      // An op that entered no event, beside one that did: as the contract has it (no fields).
      expect(contractIssues(r)).toEqual([]);
      expect(r.external_key_summary).toEqual({
        created: 0,
        updated: 1,
        unchanged: 1,
        pending: 0,
        skipped: 0,
      });
    },
    T,
  );

  it(
    "none enters: nothing appended; evidence given is not stored, and said so",
    async () => {
      await w({ sv: 1, ops: [byKey("m-1", { energy: 600 })] });
      const before = await tail();
      const r = await w({
        sv: 1,
        evidence: [{ kind: "tool_result", text: "sync batch 7" }],
        ops: [byKey("m-1", { energy: 600 })],
      });
      expect(await tail()).toBe(before);
      expect(r.warnings).toContainEqual({ code: "evidence_not_stored", evidence: [0] });
    },
    T,
  );

  it(
    "an op that left nothing stores none of its own evidence; the request's is stored",
    async () => {
      await w({ sv: 1, ops: [byKey("m-1", { energy: 600 }), byKey("m-2", { energy: 300 })] });
      const r = await w({
        sv: 1,
        evidence: [{ kind: "tool_result", text: "sync batch 8" }],
        ops: [
          byKey("m-1", { energy: 600 }, { evidence: [{ kind: "tool_result", text: "m-1 again" }] }),
          byKey("m-2", { energy: 350 }, { evidence_refs: [0] }),
        ],
      });
      const texts = (await opEvents(r.seq))
        .filter((e) => e.type === "source.recorded")
        .map((e) => e.blocks["text"]?.text);
      expect(texts).toEqual(["sync batch 8"]);
      expect(r.warnings).toContainEqual({
        code: "evidence_not_stored",
        evidence: [],
        op_evidence: [{ op: 0, evidence: [0] }],
      });
      expect(contractIssues(r)).toEqual([]);
    },
    T,
  );

  it(
    "none enters, evidence only inline: not stored, and said so by op",
    async () => {
      await w({ sv: 1, ops: [byKey("m-1", { energy: 600 })] });
      const before = await tail();
      const r = await w({
        sv: 1,
        ops: [
          byKey("m-1", { energy: 600 }, { evidence: [{ kind: "tool_result", text: "again" }] }),
        ],
      });
      expect(await tail()).toBe(before);
      expect(r.warnings).toContainEqual({
        code: "evidence_not_stored",
        evidence: [],
        op_evidence: [{ op: 0, evidence: [0] }],
      });
      expect(contractIssues(r)).toEqual([]);
    },
    T,
  );

  it(
    "unchanged after an ordinary op of the same request changed its row: the ver at the request's end",
    async () => {
      const first = await w({ sv: 1, ops: [byKey("m-1", { energy: 600, rating: 3 })] });
      const row = first.ops[0].target.row;
      const r = await w({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "meals",
            row,
            ver: first.ops[0].ver,
            set: { note: "by hand" },
          },
          byKey("m-1", { energy: 600, rating: 3 }),
        ],
      });
      expect(r.ops.map((x: Any) => [x.outcome ?? null, x.ver])).toEqual([
        [null, `v${r.seq}.0`],
        ["unchanged", `v${r.seq}.0`],
      ]);
    },
    T,
  );

  it(
    "every field a corroboration, read back from the log: updated (04-contract §5.4)",
    async () => {
      await w({ sv: 1, ops: [byKey("m-1", { energy: 600 })] });
      const r = await w({
        sv: 1,
        evidence: [{ kind: "tool_result", text: "600 kcal" }],
        ops: [byKey("m-1", { energy: 600 }, { evidence_by_field: { energy: [0] } })],
      });
      expect(r.seq).toBeGreaterThan(0);
      expect(r.ops[0].fields.energy).toMatchObject({ result: "corroborated" });
      expect(r.ops[0]).toMatchObject({ outcome: "updated" });
      expect(r.external_key_summary).toMatchObject({ updated: 1 });
    },
    T,
  );

  it(
    "the two ways of making a receipt agree on what a write by key came to",
    async () => {
      // Alone, it enters no event (assembled from the judgement); with an ordinary op beside it,
      // the request enters events (read back from the log): the same outcome, summary, warning.
      const first = await w({ sv: 1, ops: [byKey("m-1", { energy: 600 })] });
      const row = first.ops[0].target.row;
      await w({ sv: 1, ops: [{ intent: "revoke", table: "meals", row, ver: first.ops[0].ver }] });
      await w({ sv: 1, ops: [byKey("m-2", { energy: 300 })] });
      const alone = await w({
        sv: 1,
        ops: [byKey("m-1", { energy: 650 }), byKey("m-2", { energy: 300 })],
      });
      const mixed = await w({
        sv: 1,
        ops: [
          byKey("m-1", { energy: 650 }),
          byKey("m-2", { energy: 300 }),
          { intent: "insert", table: "meals", set: { note: "by hand" } },
        ],
      });
      const keyed = (x: Any) => ({
        ops: x.ops.slice(0, 2),
        summary: x.external_key_summary,
        skipped: x.warnings?.find((y: Any) => y.code === "external_key_skipped"),
      });
      expect(alone.seq).toBeUndefined();
      expect(mixed.seq).toBeGreaterThan(0);
      expect(keyed(mixed)).toEqual(keyed(alone));
    },
    T,
  );
});

describe("the contract check itself", () => {
  it("finds what the contract does not have", () => {
    const ok = {
      status: "saved",
      sv: 1,
      ops: [{ op_index: 0 }],
      derived: [],
      derived_total: 0,
      pending: [],
      superseded: [],
    };
    expect(contractIssues(ok)).toEqual([]);
    expect(contractIssues({ ...ok, seq: "1" })).toEqual(["seq"]);
    expect(contractIssues({ ...ok, ops: [{ op_index: 0, extra: 1 }] })).toEqual([
      "ops/0: op_index not in the contract",
      "ops/0: extra not in the contract",
      "ops/0: target missing",
      "ops/0: intent missing",
    ]);
    expect(
      contractIssues({
        ...ok,
        ops: [
          { target: { table: "t", row: "r" }, intent: "update", outcome: "unchanged", fields: {} },
        ],
      }),
    ).toEqual(["ops/0: fields on unchanged", "ops/0: unchanged without ver"]);
    const { superseded: _, ...noSuperseded } = ok;
    expect(contractIssues(noSuperseded)).toEqual(["result: superseded missing"]);
    const target = { table: "t", row: "r" };
    const skipped = {
      target,
      intent: "update",
      outcome: "skipped",
      skip_reason: "revoked",
      revoked_by: 3,
    };
    expect(contractIssues({ ...ok, ops: [skipped] })).toEqual([]);
    const { revoked_by: __, ...noRevokedBy } = skipped;
    expect(contractIssues({ ...ok, ops: [{ ...noRevokedBy, ver: "v3.0" }] })).toEqual([
      "ops/0: revoked without revoked_by",
      "ops/0: ver on skipped",
    ]);
    expect(
      contractIssues({
        ...ok,
        ops: [skipped],
        external_key_summary: { created: 0, updated: "1", pending: 0, skipped: 0 },
        warnings: [{ code: "made_up" }, { code: "external_key_skipped", ops: [] }],
      }),
    ).toEqual([
      "external_key_summary.updated not an integer",
      "external_key_summary.updated 1, the ops 0",
      "external_key_summary.skipped 0, the ops 1",
      "warning made_up",
      "external_key_skipped not the skipped ops",
    ]);
  });
});

describe("the request key", () => {
  it(
    "a request of writes by key only has none: sent again, judged again (unchanged)",
    async () => {
      const params = { sv: 1, ops: [byKey("m-1", { energy: 600 }), byKey("m-2", { energy: 1 })] };
      await w(params);
      const again = await w(params);
      expect(again.replayed).toBeUndefined();
      expect(again.ops.map((x: Any) => x.outcome)).toEqual(["unchanged", "unchanged"]);
    },
    T,
  );

  it(
    "an explicit idempotency key: replayed from the log, the ops that entered no event by index",
    async () => {
      await w({ sv: 1, ops: [byKey("m-1", { energy: 600 })] });
      const params = {
        sv: 1,
        idempotency_key: "batch-7",
        ops: [byKey("m-1", { energy: 600 }), byKey("m-2", { energy: 1 })],
      };
      const first = await w(params);
      const again = await w(params);
      expect(again.replayed).toBe(true);
      expect(again.seq).toBe(first.seq);
      expect(again.ops[0]).toEqual({ op_index: 0 });
      expect(again.ops[1]).toMatchObject({ outcome: "created" });
      expect(again.omitted).toContain("unrecorded_ops");
      // A replay's op that entered no event: its index only, as the contract has it.
      expect(contractIssues(again)).toEqual([]);
      expect(again.external_key_summary).toEqual({ created: 1, updated: 0, pending: 0 });
    },
    T,
  );
});

describe("the merge base of a candidate by key, by unit", () => {
  it(
    "one op with candidates in two units whose baseline positions differ: each item its own",
    async () => {
      // #a created with energy, note, rating; #b a sync of rating only (its position moves on);
      // the user changes note and rating; #c a sync of all three: candidates in {energy, note}
      // (positions #a) and in {rating} (position #b).
      const a = await w({ sv: 1, ops: [byKey("m-1", { energy: 600, note: "x", rating: 3 })] });
      const row = a.ops[0].target.row;
      const b = await w({ sv: 1, ops: [byKey("m-1", { energy: 600, note: "x", rating: 4 })] });
      await w({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "meals",
            row,
            ver: b.ops[0].ver,
            set: { note: "y", rating: 5 },
          },
        ],
      });
      const c = await w({ sv: 1, ops: [byKey("m-1", { energy: 650, note: "z", rating: 2 })] });
      expect(c.pending).toHaveLength(2);
      const created = (await opEvents(c.seq)).filter((e) => e.type === "item.created");
      const bases = created.map((e) => [e.blocks["target"].unit, e.blocks["target"].merge_base_op]);
      expect(bases).toEqual(
        expect.arrayContaining([
          [["f3", "f4"], a.seq],
          [["f5"], b.seq],
        ]),
      );
    },
    T,
  );
});

describe("a table gone since the request's version", () => {
  // A request at a version where the table had its key is not located by that version's key: the
  // table dropped since, the write is refused as a whole table changed (07 «带旧 sv 的写入»),
  // nothing located, no row created. (A key dropped from a table kept — no_external_key by the
  // current definition — below.)
  it(
    "dropped: schema_incompatible, nothing located or created",
    async () => {
      await w({ sv: 1, ops: [byKey("m-1", { energy: 600 })] });
      const d = (await schemaDraft(s.store, ctx(), {
        document: {
          slot: "food",
          base_version: 1,
          timezone: "Asia/Shanghai",
          tables: [
            {
              name: "notes",
              kind: "base",
              description: "a note",
              time: { type: "none" },
              fields: [{ name: "text", type: "text", description: "it" }],
            },
          ],
          drop_tables: ["meals"],
        },
      })) as Any;
      await resolve(s.store, ctx(), {
        id: d.item.id,
        decision: "confirm",
        item_ver: d.item.item_ver,
      });
      const before = await tail();
      expect(await refused({ sv: 1, ops: [byKey("m-2", { energy: 1 })] })).toMatchObject({
        code: "schema_incompatible",
        param: "ops/0/table",
        changed_fields: [{ field: "*", change: "drop_table" }],
      });
      expect(await tail()).toBe(before);
    },
    T,
  );
});

describe("the key dropped from a table written by key (04-write-and-read «写法与定位»)", () => {
  // The rows keep their key fields' values; the table has no key now. A request at the version
  // that had it is judged by the current definition: no_external_key, nothing located, no row
  // created, though the key's row is there. By row it is written as usual.
  it(
    "by key at the old version: no_external_key, no row created; by row: written",
    async () => {
      const made = await w({ sv: 1, ops: [byKey("m-1", { energy: 600 })] });
      const row = made.ops[0].target.row;
      const doc = (await catalog(s.store, ctx(), { level: "schema", slot: "food" })) as Any;
      const meals = doc.document.tables.find((t: Any) => t.name === "meals");
      delete meals.external_key;
      const d = (await schemaDraft(s.store, ctx(), {
        document: { ...doc.document, base_version: 1 },
      })) as Any;
      expect(d.changes).toEqual([expect.objectContaining({ change: "drop_external_key" })]);
      if (d.outcome === "pending") {
        await resolve(s.store, ctx(), {
          id: d.item.id,
          decision: "confirm",
          item_ver: d.item.item_ver,
        });
      }
      const count = () =>
        s.store.read(
          async (tx) =>
            (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM "t_${meals.id}_v1"`))
              .rows[0]?.n,
        );
      const before = await tail();
      expect(await refused({ sv: 1, ops: [byKey("m-1", { energy: 650 })] })).toMatchObject({
        code: "invalid_argument",
        reason: "no_external_key",
        param: "ops/0/external_key",
      });
      // A key not there before either: refused the same way, not added as a new row.
      expect(await refused({ sv: 1, ops: [byKey("m-9", { energy: 1 })] })).toMatchObject({
        code: "invalid_argument",
        reason: "no_external_key",
      });
      expect([await tail(), await count()]).toEqual([before, 1]);
      const byRow = await w({
        sv: 1,
        ops: [
          { intent: "update", table: "meals", row, ver: made.ops[0].ver, set: { energy: 650 } },
        ],
      });
      expect(byRow.status).toBe("saved");
      expect(await count()).toBe(1);
      const r = await reconcileLog({ live: s.store, scratch: scratch.store });
      expect(r.mismatches).toEqual([]);
    },
    T,
  );
});

describe("replayed from an empty storage", () => {
  it(
    "the log of writes by key gives the same state (log.reconcile)",
    async () => {
      await w({ sv: 1, ops: [byKey("m-1", { energy: 600 }), byKey("m-2", { energy: 300 })] });
      await w({ sv: 1, ops: [byKey("m-1", { energy: 650 }), byKey("m-2", { energy: 300 })] });
      const r = await reconcileLog({ live: s.store, scratch: scratch.store });
      expect(r.mismatches).toEqual([]);
    },
    T,
  );
});
