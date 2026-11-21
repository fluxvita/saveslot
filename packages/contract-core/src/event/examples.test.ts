// The JSON examples of docs/zh-CN/spec/09-event-format.md, reproduced as typed constants. If the
// types drift from the spec, `pnpm typecheck` (tsconfig.tests.json) fails here. The
// `@ts-expect-error` lines are negatives: each must stay a type error, so a type that became too
// loose (for instance `EventBlocks` collapsing to `{}`) fails the type check as well.
//
// Elided IDs and hashes are kept as the spec writes them (`ci_7HQ2…`, `9f2c…e1`). Placeholders the
// spec writes as `<seq>` or `…` in non-JSON tables are filled with fictional values.

import { describe, expect, it } from "vitest";
import { canonicalize } from "../jcs.ts";
import type {
  AckBlock,
  CandidateBlock,
  ChangesBlock,
  CtxBlock,
  DeletionConfirmedTarget,
  Deps,
  DerivedTarget,
  ExistenceItemBlock,
  ExistenceSpanBlock,
  FieldItemBlock,
  ItemCreatedTarget,
  ItemResolvedTarget,
  LiteralBlock,
  OpTargetBlock,
  PolicyBlock,
  PremiseBlock,
  PremiseTargetBlock,
  RegisteredPrincipalBlock,
  RestatedBlock,
  ResultFieldBlock,
  RevertBlock,
  SourcesBlock,
  SpanBlock,
  ValidParamBlock,
  WriteBaseTarget,
} from "./blocks.ts";
import type { CompiledSchema } from "./compiled.ts";
import type { EventOf, ExportEventLineOf, ExportManifest } from "./event.ts";
import type {
  DeletionExecutedHeader,
  EventHeader,
  SchemaSwitchedHeader,
  TenantRestoredHeader,
  WriteBaseHeader,
  WriteHeadHeader,
} from "./header.ts";
import type { FieldValue } from "./values.ts";
import { matchPathAll } from "./vocabulary.ts";

// --- §2.1 header -------------------------------------------------------------------------------

const writeBaseHeader = {
  actor: "ci_7HQ2…",
  at: "2026-11-10T04:41:07.123Z",
  op: 25,
  prev_hash: "9f2c…e1",
  seq: 27,
  slot: "sl_4KTZ…",
  type: "write.base",
  v: 1,
} as const satisfies WriteBaseHeader;

// --- §3.5 deps ---------------------------------------------------------------------------------

const deps35 = [
  { event: 15, field: "f2", k: 0 },
  { event: 22, existence: 0 },
] as const satisfies Deps;

// --- §5.1 ctx ----------------------------------------------------------------------------------

const ctx = {
  now: "2026-11-10T04:41:07.123Z",
  today: "2026-11-10",
  ruleset_version: 1,
  policy_version: 1,
  literal_checker: "literal@1",
} as const satisfies CtxBlock;

// --- §5.3 principal (table example) ------------------------------------------------------------

const registered = {
  principal: "ci_7HQ2…",
  kind: "connection",
  scopes: ["saveslot.read", "saveslot.write"],
  slots: ["sl_4KTZ…"],
  via: "token",
} as const satisfies RegisteredPrincipalBlock;

// --- §5.4 policy -------------------------------------------------------------------------------

const policy = {
  policy_version: 1,
  effective_value_rule: "keep_current",
  rank: { user_stated: 2, agent_inferred: 1, miss: 0 },
  auto_apply: [
    "add_table",
    "add_derived_table",
    "add_optional_field",
    "description",
    "rename_unused",
    "loosen_constraint",
    "duplicate_keys",
    "restructure_unused",
  ],
  high_impact: [],
  user_session_only: [],
} as const satisfies PolicyBlock;

// --- §5.5 changes ------------------------------------------------------------------------------

const changes = [
  {
    target: { slot: true },
    change: "create_slot",
    class: "create",
    compatible_with_old_writes: true,
    destructive: false,
    auto: true,
  },
  {
    target: { table: "t1" },
    change: "add_table",
    class: "create",
    compatible_with_old_writes: true,
    destructive: false,
    auto: true,
  },
  {
    target: { table: "t2", rule: true },
    change: "change_rule",
    class: "deterministic",
    compatible_with_old_writes: true,
    destructive: false,
    auto: false,
  },
  {
    target: { table: "t1", field: "f4" },
    change: "change_type",
    class: "deterministic",
    compatible_with_old_writes: false,
    destructive: false,
    auto: false,
  },
] as const satisfies ChangesBlock;

// --- §5.7 write.head ---------------------------------------------------------------------------

const opTarget = {
  table: "t1",
  row: "r_01JC8Z…",
  intent: "correct",
  ver: { op: 21, restore_count: 0, basis: "explicit" },
} as const satisfies OpTargetBlock;

const opValid = {
  from: { mode: "given", value: "2026-11-02" },
  to: { mode: "next_change" },
} as const satisfies ValidParamBlock;

const premise = {
  table: "t1",
  row: "r_01JF…",
  fields: ["f2"],
  ver: { op: 40, restore_count: 0, basis: "explicit" },
  range: "whole",
  state: "current",
} as const satisfies PremiseBlock;

// --- §5.7 write.base ---------------------------------------------------------------------------

const baseTarget = {
  op_index: 0,
  table: "t1",
  row: "r_01JC8Z…",
  intent: "correct",
  cause: "request",
  sv: 1,
} as const satisfies WriteBaseTarget;

const fieldApplied = {
  status: "applied",
  value: { value: "54", unit: "CNY" },
} as const satisfies FieldItemBlock;

const spanValid = {
  valid: { from: "2026-11-02", to: "2026-11-10" },
  deps: [{ event: 15, field: "f2", k: 0 }],
} as const satisfies SpanBlock;

const spanSeen = { seen_valid: { from: "2026-11-02" } } as const satisfies SpanBlock;

const sourcesValue = [{ kind: "value", source: 26 }] as const satisfies SourcesBlock;
const sourcesCarried = [
  { kind: "value", carried: { event: 39, field: "f3", k: 0 } },
] as const satisfies SourcesBlock;

const existenceItem = {
  status: "applied",
  scope: "interval",
} as const satisfies ExistenceItemBlock;
const existenceSpan = {
  valid: { from: "2026-11-10", to: "2026-11-20" },
} as const satisfies ExistenceSpanBlock;

const literal = {
  segments: [
    { source: 22, result: "hit" },
    { source: 26, result: "miss" },
  ],
} as const satisfies LiteralBlock;

const revertUndo = {
  before_op: 25,
  items: [
    { event: 27, field: "f3" },
    { event: 27, field: "f1" },
  ],
  skipped: [{ event: 27, field: "f1", by_op: 33 }],
} as const satisfies RevertBlock;

const revertTakePrevious = {
  as_of_op: 29,
  item: "pi_3KD…",
  items: [{ event: 35, field: "f3" }],
} as const satisfies RevertBlock;

const ack = {
  field: "f2",
  valid: { from: "2026-11-02", to: "2026-11-10" },
  value: { value: "5000", unit: "CNY" },
  op: 20,
  deps: [{ event: 22, field: "f2", k: 0 }],
} as const satisfies AckBlock;

/** The worked examples after §5.7 (text blocks in the spec), as typed write.base block sets. */
const revertRestoreExistence = {
  "existence/0": { status: "applied", scope: "interval" },
  "span/existence/0": {
    valid: { from: "2026-11-05", to: "2026-11-15" },
    deps: [
      { event: 32, existence: 0 },
      { event: 22, existence: 0 },
    ],
  },
  revert: { before_op: 30, items: [{ event: 32, existence: true }] },
} as const;

const revertTwoStretches = {
  "existence/0": { status: "applied", scope: "interval", restored: true },
  "span/existence/0": {
    valid: { from: "2026-11-05", to: "2026-11-08" },
    deps: [
      { event: 22, existence: 0 },
      { event: 27, field: "f2", k: 0 },
    ],
  },
  "existence/1": { status: "applied", scope: "interval", restored: true },
  "span/existence/1": {
    valid: { from: "2026-11-10", to: "2026-11-15" },
    deps: [
      { event: 22, existence: 0 },
      { event: 27, field: "f2", k: 0 },
    ],
  },
  revert: { before_op: 20, items: [{ event: 22, existence: true }] },
} as const;

const revertUncovered = {
  "fields/f2/0": { status: "applied", uncovered: true },
  "span/f2/0": {
    valid: { from: "2026-11-08", to: "2026-11-10" },
    deps: [
      { event: 27, field: "f2", k: 0 },
      { event: 22, existence: 0 },
    ],
  },
  revert: { before_op: 25, items: [{ event: 27, field: "f2" }] },
} as const;

const revertNoValue = {
  "fields/f2/0": { status: "applied", no_value: true },
  "span/f2/0": {
    valid: { from: "2026-11-02", to: "2026-11-20" },
    deps: [{ event: 22, field: "f2", k: 0 }],
  },
  revert: { before_op: 20, items: [{ event: 22, field: "f2" }] },
} as const;

const takePrevious = {
  "fields/f2/0": { status: "applied", value: { value: "5000", unit: "CNY" } },
  "sources/f2/0": [{ kind: "value", carried: { event: 12, field: "f2", k: 0 } }],
  "span/f2/0": {
    valid: { from: "2026-11-10", to: "2026-11-15" },
    deps: [
      { event: 12, field: "f2", k: 0 },
      { event: 22, field: "f2", k: 0 },
      { event: 27, field: "f2", k: 0 },
    ],
  },
  revert: { as_of_op: 10, item: "pi_…", items: [{ event: 22, field: "f2" }] },
} as const;

const undoTwoSegments = {
  "fields/f2/0": { status: "applied", value: { value: "5000", unit: "CNY" } },
  "sources/f2/0": [{ kind: "value", carried: { event: 12, field: "f2", k: 0 } }],
  "span/f2/0": {
    valid: { from: "2026-11-02", to: "2026-11-10" },
    deps: [
      { event: 12, field: "f2", k: 0 },
      { event: 15, field: "f2", k: 0 },
      { event: 22, field: "f2", k: 0 },
    ],
  },
  "fields/f2/1": { status: "applied", value: { value: "4000", unit: "CNY" } },
  "sources/f2/1": [{ kind: "value", carried: { event: 15, field: "f2", k: 0 } }],
  "span/f2/1": {
    valid: { from: "2026-11-10", to: "2026-11-20" },
    deps: [
      { event: 15, field: "f2", k: 0 },
      { event: 22, field: "f2", k: 0 },
    ],
  },
  revert: { before_op: 20, items: [{ event: 22, field: "f2" }] },
} as const;

/** A whole write.base event with the blocks of one of the worked examples. */
const takePreviousEvent = {
  header: {
    actor: "u_5ZR1…",
    at: "2026-11-10T06:00:00.000Z",
    op: 40,
    prev_hash: "b71d…04",
    seq: 41,
    slot: "sl_4KTZ…",
    type: "write.base",
    v: 1,
  },
  blocks: {
    target: {
      table: "t3",
      entity: "e_01JC7Q…",
      intent: "update",
      cause: "resolve",
      item: "pi_…",
      sv: 1,
    },
    ...takePrevious,
  },
} as const satisfies EventOf<"write.base">;

const withExamples = [
  revertRestoreExistence,
  revertTwoStretches,
  revertUncovered,
  revertNoValue,
  undoTwoSegments,
].map((blocks) => ({
  header: writeBaseHeader,
  blocks: { target: baseTarget, ...blocks },
})) satisfies EventOf<"write.base">[];

// --- §5.7 write.derived (table example, `<seq>` filled in) --------------------------------------

const derivedTarget = {
  table: "t2",
  rule: "r1",
  rule_version: 1,
  partition: "p_8WM…",
  read_pos: 23,
  reads: [{ table: "t1" }],
  emptied: false,
} as const satisfies DerivedTarget;

// --- §5.8 items --------------------------------------------------------------------------------

const itemTarget = {
  item: "pi_3KD…",
  type: "conflict",
  reason: "stale_write",
  table: "t1",
  row: "r_01JC9A…",
  unit: ["f3"],
  merge_base_op: 29,
  origin_event: 39,
  ruleset_version: 1,
  policy_version: 1,
} as const satisfies ItemCreatedTarget;

const candidate = {
  event: 39,
  intent: "correct",
  seen: { op: 29, restore_count: 0 },
  cause: "stale_write",
  items: [{ field: "f3", k: 0, value: { value: "32", unit: "CNY" } }],
  deps: [{ event: 39, field: "f3", k: 0 }],
} as const satisfies CandidateBlock;

/** §5.8: the existence unit is the array `["existence"]`. */
const existenceItemTarget = {
  item: "pi_7C2E…",
  type: "conflict",
  reason: "stale_write",
  table: "t3",
  entity: "e_01JC7Q…",
  unit: ["existence"],
  merge_base_op: 29,
  origin_event: 39,
  ruleset_version: 1,
  policy_version: 1,
} as const satisfies ItemCreatedTarget;

const resolvedTarget = {
  item: "pi_3KD…",
  decision: "take_candidate",
  candidate: 0,
  item_op: 37,
  restore_count: 0,
  via: "call",
} as const satisfies ItemResolvedTarget;

// --- §5.9 deletion -----------------------------------------------------------------------------

const deletionTarget = {
  deletion: "pi_9QX…",
  kind: "privacy",
  due_at: "2026-11-11T05:02:11.000Z",
  sources: [26],
  origin: "request",
} as const satisfies DeletionConfirmedTarget;

const resultFieldEvent = {
  value: { value: "45", unit: "CNY" },
  sources: [{ kind: "value", carried: { event: 23, field: "f3", k: 0 } }],
} as const satisfies ResultFieldBlock;

const resultFieldState = {
  valid: { from: "2026-11-20" },
  value: { value: "5000", unit: "CNY" },
  sources: [{ kind: "value", carried: { event: 12, field: "f2", k: 0 } }],
  deps: [
    { event: 12, field: "f2", k: 0 },
    { event: 32, field: "f2", k: 0 },
  ],
} as const satisfies ResultFieldBlock;

const restatedApplied = {
  event: 18,
  field: "f2",
  k: 0,
  status: "applied",
  valid: { from: "2026-11-02" },
} as const satisfies RestatedBlock;

const restatedCorroborated = {
  event: 26,
  field: "f2",
  k: 0,
  status: "corroborated",
  valid: { from: "2026-11-05", to: "2026-11-20" },
} as const satisfies RestatedBlock;

const deletionEvent = {
  header: {
    actor: "ci_7HQ2…",
    at: "2026-11-10T05:02:11.000Z",
    prev_hash: "41aa…9c",
    seq: 42,
    slot: "sl_4KTZ…",
    type: "deletion.confirmed",
    v: 1,
  },
  blocks: {
    ctx: {
      now: "2026-11-10T05:02:11.000Z",
      today: "2026-11-10",
      ruleset_version: 1,
      policy_version: 1,
    },
    target: deletionTarget,
    positions: [
      { seq: 26, path: "text" },
      { seq: 27, path: "fields/f3/0" },
      { seq: 42, path: "summary" },
    ],
    summary: { hash: "77e0…1b" },
    "results/0/target": { table: "t1", row: "r_01JC8Z…", outcome: "fields_reverted" },
    "results/0/fields/f3/0": resultFieldEvent,
  },
} as const satisfies EventOf<"deletion.confirmed">;

const tombstoneHeader = {
  actor: "system",
  at: "2026-11-11T05:02:11.000Z",
  prev_hash: "0c5e…7a",
  seq: 44,
  slot: "sl_4KTZ…",
  trigger: "deletion_expiry",
  type: "deletion.executed",
  v: 1,
} as const satisfies DeletionExecutedHeader;

// --- §5.10 premise.changed ---------------------------------------------------------------------

const premiseTarget = {
  table: "t1",
  row: "r_01JF…",
  by_event: 62,
  changed: [{ op: 50, i: 0, j: 0, reason: "update" }],
  matched: [{ op: 73, i: 0, j: 0 }],
  repointed: [{ op: 45, i: 1, j: 0 }],
} as const satisfies PremiseTargetBlock;

// --- §5.2 / §5.5 headers with system triggers ----------------------------------------------------

const restoredHeader = {
  actor: "system",
  at: "2026-11-12T01:00:00.000Z",
  prev_hash: "5d0f…ee",
  seq: 61,
  type: "tenant.restored",
  v: 1,
  trigger: "restore",
  node_id: "n_4Q9B…",
  restore_id: "rs_8HKD…",
  restore_count: 1,
  restored_to: 55,
  high_water: 60,
} as const satisfies TenantRestoredHeader;

const switchedHeadHeader = {
  actor: "system",
  at: "2026-11-12T02:00:00.000Z",
  prev_hash: "aa01…3f",
  seq: 70,
  slot: "sl_4KTZ…",
  trigger: "migration",
  type: "schema.switched",
  v: 1,
} as const satisfies SchemaSwitchedHeader;

const switchedMemberHeader = {
  actor: "u_5ZR1…",
  at: "2026-11-10T03:00:00.000Z",
  op: 2,
  prev_hash: "1f00…20",
  seq: 6,
  slot: "sl_4KTZ…",
  type: "schema.switched",
  v: 1,
} as const satisfies SchemaSwitchedHeader;

// --- §7 compiled -------------------------------------------------------------------------------

const compiled = {
  compiler: 1,
  rsql: "rsql@1",
  slot: "sl_4KTZ…",
  name: "ledger",
  sv: 1,
  timezone: "Asia/Shanghai",
  tables: [
    {
      id: "t1",
      name: "expenses",
      kind: "base",
      description: "每笔支出一行",
      aliases: ["花销", "开销"],
      time: { type: "event", field: "f1" },
      physical: { table: "t_t1_v1" },
      fields: [
        { id: "f1", name: "date", type: "date", required: true, description: "支出当天" },
        { id: "f2", name: "category", type: "text", required: true, description: "类别" },
        {
          id: "f3",
          name: "amount",
          type: "quantity",
          required: true,
          min: "0",
          description: "金额",
          unit: { code: "CNY", dimension: "currency:CNY" },
          precision: { scale: 2, rounding: "half_up" },
        },
        { id: "f4", name: "note", type: "text", description: "备注" },
      ],
      duplicate_keys: [["f1", "f2", "f3"]],
      together: [],
    },
    {
      id: "t2",
      name: "monthly_total",
      kind: "derived",
      description: "每月支出合计",
      physical: { table: "d_t2_v1" },
      rule: {
        id: "r1",
        version: 1,
        rsql: "rsql@1",
        sql: 'SELECT date_trunc(\'month\', "t1"."f1"::timestamp)::date AS "f1", sum("t1"."f3") AS "f2" FROM "t1" GROUP BY 1',
        time_dependency: "bucketed",
        depends_on: [
          { table: "t1", field: "f1" },
          { table: "t1", field: "f3" },
        ],
        scope: { kind: "group", key: ["f1"], key_from_free_text: false },
      },
      fields: [
        { id: "f1", name: "month", type: "date", description: "该月第一天" },
        {
          id: "f2",
          name: "total",
          type: "quantity",
          description: "该月支出合计",
          unit: { code: "CNY", dimension: "currency:CNY" },
          precision: { scale: 2, rounding: "half_up" },
        },
      ],
    },
  ],
} as const satisfies CompiledSchema;

// --- §8 export ---------------------------------------------------------------------------------

const manifest = {
  saveslot_export: 1,
  tenant_id: "tn_…",
  event_format: 1,
  restore_count: 0,
  upto: 43,
  events: 43,
  exported_at: "2026-11-10T08:00:00.000Z",
  pending_deletions: "placeholder",
} as const satisfies ExportManifest;

const exportLine = {
  h: {
    actor: "ci_7HQ2…",
    at: "2026-11-10T04:41:07.123Z",
    op: 25,
    prev_hash: "9f2c…e1",
    seq: 27,
    slot: "sl_4KTZ…",
    type: "write.base",
    v: 1,
  },
  c: {
    "fields/f3/0": { pending_deletion: 42 },
    "literal/f3/0": { pending_deletion: 42 },
    "sources/f3/0": { pending_deletion: 42 },
    target: {
      v: {
        cause: "request",
        intent: "correct",
        op_index: 0,
        row: "r_01JC8Z…",
        sv: 1,
        table: "t1",
      },
      sum: "c20a…5d",
    },
  },
} as const satisfies ExportEventLineOf<"write.base">;

// =============================================================================================
// Negatives: each line below must remain a type error.

const _negatives = () => {
  const headHeader: WriteHeadHeader = {
    actor: "ci_7HQ2…",
    at: "2026-11-10T04:41:07.123Z",
    prev_hash: "9f2c…e1",
    seq: 21,
    slot: "sl_4KTZ…",
    type: "write.head",
    v: 1,
    // @ts-expect-error a head event has no `op`
    op: 21,
  };
  // @ts-expect-error a member event must carry `op`
  const memberWithoutOp: WriteBaseHeader = { ...writeBaseHeader, op: undefined };
  // @ts-expect-error `slot` is not on tenant-level events
  const tenantWithSlot: TenantRestoredHeader = { ...restoredHeader, slot: "sl_4KTZ…" };
  // @ts-expect-error `trigger` only on head events by `system`
  const callerTrigger: WriteHeadHeader = { ...headHeader, trigger: "restore" };
  // @ts-expect-error a member event never carries `trigger`
  const memberTrigger: WriteBaseHeader = { ...writeBaseHeader, trigger: "migration" };
  // @ts-expect-error `v` is 1 for every type in this version
  const v2: WriteBaseHeader = { ...writeBaseHeader, v: 2 };
  // @ts-expect-error `node_id` is not a write.base header field
  const extraField: WriteBaseHeader = { ...writeBaseHeader, node_id: "n_4Q9B…" };
  const anyHeader: EventHeader = writeBaseHeader;

  // @ts-expect-error a decimal is a string, never a JSON number
  const decimalAsNumber: FieldValue = { value: 54, unit: "CNY" };
  // @ts-expect-error absent optional fields are not encoded as null
  const nullForAbsent: OpTargetBlock = { ...opTarget, ver: null };
  // @ts-expect-error `high_impact` is always empty in v1 (non-empty is a reserved shape)
  const highImpact: PolicyBlock = { ...policy, high_impact: [{ table: "t1", fields: ["f2"] }] };
  // @ts-expect-error `applied_by_rule` is a reserved intent
  const reservedIntent: WriteBaseTarget = { ...baseTarget, intent: "applied_by_rule" };
  // @ts-expect-error `elicitation` is a reserved `via`
  const reservedVia: ItemResolvedTarget = { ...resolvedTarget, via: "elicitation" };
  // @ts-expect-error `ruling` is a reserved write cause
  const reservedCause: WriteBaseTarget = { ...baseTarget, cause: "ruling" };
  // @ts-expect-error `reextract` is a reserved change class
  const reservedClass: ChangesBlock = [{ ...changes[0], class: "reextract" }];
  // @ts-expect-error the conflict unit is always an array, also for existence
  const unitString: ItemCreatedTarget = { ...existenceItemTarget, unit: "existence" };
  // @ts-expect-error a row target and an entity target are exclusive
  const rowAndEntity: OpTargetBlock = { ...opTarget, entity: "e_01JC7Q…" };
  // @ts-expect-error `no_value` items carry no value
  const noValueWithValue: FieldItemBlock = { status: "applied", no_value: true, value: "x" };
  // @ts-expect-error `applied_by_rule` is a reserved status (§6.3)
  const reservedStatus: FieldItemBlock = { status: "applied_by_rule", value: "x" };
  // @ts-expect-error `dropped` only appears in restated blocks
  const droppedInBase: FieldItemBlock = { status: "dropped", value: "x" };
  // @ts-expect-error `candidate` only with `take_candidate`
  const candidateWithKeep: ItemResolvedTarget = { ...resolvedTarget, decision: "keep_effective" };
  // @ts-expect-error a row ID is not a rule ID
  const ruleAsRow: DerivedTarget = { ...derivedTarget, rule: "r_01JC8Z…" };
  type BaseBlocks = EventOf<"write.base">["blocks"];
  const wrongPath: BaseBlocks = {
    target: baseTarget,
    // @ts-expect-error `ops/<i>/...` paths do not exist on write.base
    "ops/0/target": opTarget,
  };
  const wrongShape: BaseBlocks = {
    target: baseTarget,
    // @ts-expect-error a block at a known path must have that path's shape
    "fields/f3/0": literal,
  };
  // @ts-expect-error `target` is required on write.base
  const missingTarget: EventOf<"write.base">["blocks"] = { "fields/f3/0": fieldApplied };
  // @ts-expect-error the export manifest's `tenant_id` is a tenant ID
  const badManifest: ExportManifest = { ...manifest, tenant_id: "sl_4KTZ…" };
  const badState: ExportEventLineOf<"write.base"> = {
    h: writeBaseHeader,
    // @ts-expect-error an export block state is one of three shapes (here `sum` is missing)
    c: { target: { v: baseTarget } },
  };

  // A1: values in deletion results and valued restatements are carried or schema constants.
  const resultDirectSource: ResultFieldBlock = {
    value: { value: "45", unit: "CNY" },
    // @ts-expect-error a result value never names a source directly (it would escape the cascade)
    sources: [{ kind: "value", source: 26 }],
  };
  const restatedDirectSource: RestatedBlock = {
    event: 32,
    field: "f2",
    k: 0,
    status: "applied",
    value: { value: "5000", unit: "CNY" },
    // @ts-expect-error a restated value never names a source directly
    sources: [{ kind: "value", source: 26 }],
  };
  // A2: ctx keys per head event type.
  type WriteCtx = EventOf<"write.head">["blocks"]["ctx"];
  type DeletionCtx = EventOf<"deletion.confirmed">["blocks"]["ctx"];
  type PrincipalCtx = EventOf<"principal.revoked">["blocks"]["ctx"];
  // @ts-expect-error a write.head ctx has `today` (the operation is in a slot)
  const writeCtxNoToday: WriteCtx = {
    now: "2026-11-10T04:41:07.123Z",
    ruleset_version: 1,
    policy_version: 1,
    literal_checker: "literal@1",
  };
  // @ts-expect-error a write.head ctx has `literal_checker`
  const writeCtxNoChecker: WriteCtx = {
    now: "2026-11-10T04:41:07.123Z",
    today: "2026-11-10",
    ruleset_version: 1,
    policy_version: 1,
  };
  const deletionCtxChecker: DeletionCtx = {
    now: "2026-11-10T05:02:11.000Z",
    today: "2026-11-10",
    ruleset_version: 1,
    policy_version: 1,
    // @ts-expect-error `literal_checker` only on write.head
    literal_checker: "literal@1",
  };
  const principalCtxToday: PrincipalCtx = {
    now: "2026-11-10T05:02:11.000Z",
    ruleset_version: 1,
    // @ts-expect-error principal events have no slot, so no `today`
    today: "2026-11-10",
  };
  // A3: `later` only in an `undo` revert record.
  const laterOnTakePrevious: RevertBlock = {
    as_of_op: 29,
    item: "pi_3KD…",
    // @ts-expect-error `include_later` (and so `later`) exists only for `undo`
    items: [{ event: 35, field: "f3", later: true }],
  };
  // Positive control for A3: the same item is fine in an `undo` record.
  const laterOnUndo: RevertBlock = {
    before_op: 25,
    items: [{ event: 35, field: "f3", later: true }],
  };
  // A revert record lists (event, target) entries, not items by index.
  const revertWithIndex: RevertBlock = {
    before_op: 25,
    // @ts-expect-error a revert record entry has no `k`
    items: [{ event: 27, field: "f3", k: 0 }],
  };
  // A4: a result segment has `valid` and `deps` together or neither.
  const from1120 = { from: "2026-11-20" } as const;
  // @ts-expect-error `valid` without `deps`
  const validWithoutDeps: ResultFieldBlock = { ...resultFieldEvent, valid: from1120 };
  // @ts-expect-error `deps` without `valid`
  const depsWithoutValid: ResultFieldBlock = { ...resultFieldEvent, deps: [] };
  // §7: `description` is required on tables and fields; `required` appears only as `true`.
  // @ts-expect-error a compiled table has a `description`
  const tableNoDescription: CompiledSchema["tables"][number] = {
    id: "t9",
    name: "notes",
    kind: "base",
    time: { type: "none" },
    physical: { table: "t_t9_v1" },
    fields: [{ id: "f1", name: "body", type: "text", description: "Body" }],
  };
  const fieldNoDescription: CompiledSchema["tables"][number] = {
    id: "t9",
    name: "notes",
    kind: "base",
    description: "Notes",
    time: { type: "none" },
    physical: { table: "t_t9_v1" },
    // @ts-expect-error a compiled field has a `description`
    fields: [{ id: "f1", name: "body", type: "text" }],
  };
  const requiredFalse: CompiledSchema["tables"][number] = {
    id: "t9",
    name: "notes",
    kind: "base",
    description: "Notes",
    time: { type: "none" },
    physical: { table: "t_t9_v1" },
    // @ts-expect-error `required` is written only when `true`
    fields: [{ id: "f1", name: "body", type: "text", description: "Body", required: false }],
  };
  // §1.3: a raw value keeps the caller's text, so a non-canonical decimal is a valid set block.
  const rawSet: EventOf<"write.head">["blocks"]["ops/0/set/f3"] = { value: "1.0", unit: "CNY" };
  // A5: blocks every event of the type has must be present in an export line.
  const lineWithoutTarget: ExportEventLineOf<"write.base"> = {
    h: writeBaseHeader,
    // @ts-expect-error write.base lines always carry `target`
    c: { "fields/f3/0": { pending_deletion: 42 } },
  };
  // @ts-expect-error a type with required blocks has `c`
  const lineWithoutC: ExportEventLineOf<"write.base"> = { h: writeBaseHeader };
  const restoredLine: ExportEventLineOf<"tenant.restored"> = { h: restoredHeader };
  return [
    tableNoDescription,
    fieldNoDescription,
    requiredFalse,
    rawSet,
    resultDirectSource,
    restatedDirectSource,
    writeCtxNoToday,
    writeCtxNoChecker,
    deletionCtxChecker,
    principalCtxToday,
    laterOnTakePrevious,
    laterOnUndo,
    revertWithIndex,
    validWithoutDeps,
    depsWithoutValid,
    lineWithoutTarget,
    lineWithoutC,
    restoredLine,
    memberWithoutOp,
    tenantWithSlot,
    callerTrigger,
    memberTrigger,
    v2,
    extraField,
    anyHeader,
    decimalAsNumber,
    nullForAbsent,
    highImpact,
    reservedIntent,
    reservedVia,
    reservedCause,
    reservedClass,
    unitString,
    rowAndEntity,
    noValueWithValue,
    reservedStatus,
    droppedInBase,
    candidateWithKeep,
    ruleAsRow,
    wrongPath,
    wrongShape,
    missingTarget,
    badManifest,
    badState,
  ];
};

// =============================================================================================
// Runtime checks on the same examples

describe("spec examples", () => {
  it("the §2.1 header example is already in JCS form", () => {
    expect(canonicalize(writeBaseHeader)).toBe(
      '{"actor":"ci_7HQ2…","at":"2026-11-10T04:41:07.123Z","op":25,"prev_hash":"9f2c…e1","seq":27,"slot":"sl_4KTZ…","type":"write.base","v":1}',
    );
  });

  it("the §8 event line header canonicalizes to the same bytes as §2.1", () => {
    expect(canonicalize(exportLine.h)).toBe(canonicalize(writeBaseHeader));
  });

  const blockSets: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["write.base", takePreviousEvent.blocks],
    ...withExamples.map((e) => ["write.base", e.blocks] as const),
    ["write.base", exportLine.c],
    ["deletion.confirmed", deletionEvent.blocks],
  ];

  it.each(blockSets)("every block path of a %s example is in the vocabulary", (type, blocks) => {
    for (const path of Object.keys(blocks)) {
      expect(matchPathAll(type, path), `${type} ${path}`).toHaveLength(1);
    }
  });

  it("deletion positions in the examples name vocabulary paths", () => {
    // 42 is the confirmation itself: its summary is on its own list.
    const types = { 26: "source.recorded", 27: "write.base", 42: "deletion.confirmed" } as const;
    for (const { seq, path } of deletionEvent.blocks.positions) {
      expect(matchPathAll(types[seq], path)).toHaveLength(1);
    }
  });

  it("keeps the typed constants referenced", () => {
    // The constants above exist for the type checker; referencing them keeps lint quiet.
    const all = [
      deps35,
      ctx,
      registered,
      changes,
      opValid,
      premise,
      spanValid,
      spanSeen,
      sourcesValue,
      sourcesCarried,
      existenceItem,
      existenceSpan,
      revertUndo,
      revertTakePrevious,
      ack,
      itemTarget,
      candidate,
      restatedApplied,
      restatedCorroborated,
      resultFieldState,
      tombstoneHeader,
      premiseTarget,
      switchedHeadHeader,
      switchedMemberHeader,
      compiled,
      _negatives,
    ];
    expect(all.every((x) => x !== undefined)).toBe(true);
  });
});
