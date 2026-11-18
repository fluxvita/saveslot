// The MCP tools and the contract operations they call (docs/zh-CN/spec/05-surfaces.md §1, §2,
// §8, §9.1). A tool is listed to a credential that has its scope (05 §1 «工具列表按 scope 裁剪»);
// its parameters are the operation's, less the ones MCP does not expose (05 §2), each of which is
// named in `withheld`.

import type { Operation, Principal, Scope } from "@fluxvita/saveslot-service";
import type { JSONObject } from "@modelcontextprotocol/server";
import type { ToolName } from "./names.ts";
import {
  CATALOG,
  COMMON,
  compose,
  DRAFT_IDEMPOTENCY_KEY,
  HISTORY,
  IDEMPOTENCY_KEY,
  PENDING,
  QUERY,
  RESOLVE,
  SCHEMA_DRAFT,
  type Text,
  WRITE,
} from "./texts.ts";

export type { ToolName };

type JsonSchema = JSONObject;

/** A parameter: its JSON Schema without the description, and the description's text. */
interface Param {
  readonly schema: JsonSchema;
  readonly text: Text;
  readonly required?: true;
}

export interface Tool {
  readonly name: ToolName;
  readonly operation: Operation;
  /** The scope a credential needs to have the tool listed and to call it. */
  readonly scope: Scope;
  readonly description: Text;
  readonly params: Readonly<Record<string, Param>>;
  /** The operation's parameters MCP does not expose (05 §2), with why. */
  readonly withheld: Readonly<Record<string, string>>;
  /** Alternatives the arguments must match exactly one of (`history` by `mode`: 05 §2). */
  readonly oneOf?: readonly JsonSchema[];
  /** A field inside the arguments MCP does not expose (05 §2), as the path to it, if one is there. */
  readonly refuse?: (args: Readonly<Record<string, unknown>>) => string | undefined;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint: false;
  };
  /** Arguments that are right as they stand, checked against the schema and the kernel. */
  readonly examples: readonly Readonly<Record<string, unknown>>[];
}

const str: JsonSchema = { type: "string" };
const bool: JsonSchema = { type: "boolean" };
const names: JsonSchema = { type: "array", items: str };
const limit = (max: number): JsonSchema => ({ type: "integer", minimum: 1, maximum: max });

const task: Param = { schema: str, text: COMMON.task };
const cursor: Param = { schema: str, text: COMMON.cursor };

/** 04-contract-types §4.3 `WhereOp`. */
const WHERE_OPS = ["=", "!=", "<", "<=", ">", ">=", "in", "contains", "is_null"];

/** An evidence segment (04-contract-types §2), without `level`: MCP does not expose it (05 §2). */
const SEGMENT: JsonSchema = {
  type: "object",
  properties: {
    kind: { enum: ["user_message", "agent_note", "tool_result", "file_ref", "source_ref"] },
    text: str,
    stated_at: str,
    name: str,
    mime: str,
    size: { type: "integer", minimum: 0 },
    sha256: str,
    origin: str,
    excerpt: str,
    id: str,
  },
  required: ["kind"],
  additionalProperties: false,
};

/** Field name (or `valid`) → indexes of evidence segments. */
const BY_FIELD: JsonSchema = {
  type: "object",
  additionalProperties: { type: "array", items: { type: "integer", minimum: 0 }, minItems: 1 },
};

const keyValues: JsonSchema = { type: "object" };

/** A premise (04-contract-types §5.1 `PremiseRef`). */
const PREMISE: JsonSchema = {
  type: "object",
  properties: {
    table: str,
    row: str,
    entity: str,
    entity_key: keyValues,
    fields: names,
    ver: str,
    valid_at: str,
    valid_during: {
      type: "array",
      prefixItems: [str, { type: ["string", "null"] }],
      minItems: 2,
      maxItems: 2,
    },
  },
  required: ["table"],
  additionalProperties: false,
};

/** A write op (04-contract-types §5.1 `WriteOp`), without `acknowledge` (05 §2). */
const WRITE_OP: JsonSchema = {
  type: "object",
  properties: {
    intent: { enum: ["insert", "update", "correct", "revoke"] },
    table: str,
    row: str,
    entity: str,
    entity_key: keyValues,
    external_key: keyValues,
    as: str,
    ver: str,
    set: { type: "object" },
    revert: {
      type: "object",
      properties: { undo: { type: "integer", minimum: 1 }, include_later: bool },
      required: ["undo"],
      additionalProperties: false,
    },
    valid_from: str,
    valid_to: str,
    evidence: { type: "array", items: SEGMENT },
    evidence_refs: { type: "array", items: { type: "integer", minimum: 0 } },
    evidence_by_field: BY_FIELD,
    premises: { type: "array", items: PREMISE },
  },
  required: ["table"],
  additionalProperties: false,
};

/** The index of an evidence segment that carries `level`, if any. */
function levelIn(evidence: unknown): number | undefined {
  if (!Array.isArray(evidence)) return undefined;
  const i = evidence.findIndex((e) => e !== null && typeof e === "object" && "level" in e);
  return i < 0 ? undefined : i;
}

/** The tools of this version, in the order they are listed. */
export const TOOLS: readonly Tool[] = [
  {
    name: "saveslot_catalog",
    operation: "catalog",
    scope: "saveslot.read",
    description: CATALOG.description,
    params: {
      level: { schema: { enum: ["list", "table", "schema"] }, text: CATALOG.params.level },
      slot: { schema: str, text: CATALOG.params.slot },
      draft: { schema: str, text: CATALOG.params.draft },
      tables: {
        schema: { ...names, minItems: 1, maxItems: 10 },
        text: CATALOG.params.tables,
      },
      limit: { schema: limit(200), text: CATALOG.params.limit },
      cursor,
      task,
    },
    withheld: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    examples: [{}, { level: "list", limit: 10 }, { level: "table", tables: ["ledger.expenses"] }],
  },
  {
    name: "saveslot_query",
    operation: "query",
    scope: "saveslot.read",
    description: QUERY.description,
    params: {
      table: { schema: str, text: QUERY.params.table, required: true },
      where: {
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: { field: str, op: { enum: WHERE_OPS }, value: {} },
            required: ["field", "op"],
            additionalProperties: false,
          },
        },
        text: QUERY.params.where,
      },
      order: {
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: { field: str, dir: { enum: ["asc", "desc"] } },
            required: ["field"],
            additionalProperties: false,
          },
        },
        text: QUERY.params.order,
      },
      fields: { schema: names, text: QUERY.params.fields },
      valid_at: { schema: str, text: QUERY.params.valid_at },
      valid_during: {
        schema: {
          type: "array",
          prefixItems: [str, { type: ["string", "null"] }],
          minItems: 2,
          maxItems: 2,
        },
        text: QUERY.params.valid_during,
      },
      clip: { schema: bool, text: QUERY.params.clip },
      coalesce: { schema: bool, text: QUERY.params.coalesce },
      at: { schema: str, text: QUERY.params.at },
      include_revoked: { schema: bool, text: QUERY.params.include_revoked },
      detail: { schema: { enum: ["concise", "detailed"] }, text: COMMON.detail },
      limit: { schema: limit(200), text: COMMON.limit },
      cursor,
      task,
    },
    withheld: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    examples: [
      { table: "ledger.expenses" },
      {
        table: "expenses",
        where: [{ field: "note", op: "contains", value: "tea" }],
        order: [{ field: "date", dir: "asc" }],
        fields: ["date", "note"],
        valid_during: ["2026-11-01", null],
        limit: 5,
        detail: "concise",
        task: "weekly-review",
      },
    ],
  },
  {
    name: "saveslot_history",
    operation: "history",
    scope: "saveslot.read",
    description: HISTORY.description,
    params: {
      mode: { schema: { enum: ["timeline", "as_of", "changes"] }, text: HISTORY.params.mode },
      table: { schema: str, text: HISTORY.params.table, required: true },
      row: { schema: str, text: HISTORY.params.row },
      entity: { schema: str, text: HISTORY.params.entity },
      entity_key: { schema: { type: "object" }, text: HISTORY.params.entity_key },
      expand_sources: { schema: bool, text: HISTORY.params.expand_sources },
      as_of: {
        schema: {
          oneOf: [
            { type: "integer", minimum: 1 },
            str,
            {
              type: "object",
              properties: { read: str },
              required: ["read"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { task: str },
              required: ["task"],
              additionalProperties: false,
            },
          ],
        },
        text: HISTORY.params.as_of,
      },
      valid_at: { schema: str, text: HISTORY.params.valid_at },
      detail: { schema: { enum: ["concise", "detailed"] }, text: COMMON.detail },
      since: {
        schema: { oneOf: [{ type: "integer", minimum: 0 }, str] },
        text: HISTORY.params.since,
      },
      until: {
        schema: { oneOf: [{ type: "integer", minimum: 0 }, str] },
        text: HISTORY.params.until,
      },
      limit: { schema: limit(200), text: COMMON.limit },
      cursor,
      task,
    },
    withheld: {
      external_key: "a read takes no source key (04-contract-types §1.5)",
      key: "05 §9.1 gives history no derived-row target",
    },
    oneOf: [
      {
        properties: { mode: { const: "timeline" } },
        not: {
          anyOf: ["as_of", "valid_at", "detail", "since", "until"].map((p) => ({ required: [p] })),
        },
      },
      {
        properties: { mode: { const: "as_of" } },
        required: ["mode", "as_of"],
        not: { anyOf: ["expand_sources", "since", "until"].map((p) => ({ required: [p] })) },
      },
      {
        properties: { mode: { const: "changes" } },
        required: ["mode", "since"],
        not: {
          anyOf: ["expand_sources", "as_of", "valid_at", "detail"].map((p) => ({ required: [p] })),
        },
      },
    ],
    annotations: { readOnlyHint: true, openWorldHint: false },
    examples: [
      { table: "ledger.expenses", row: `r_${"1".repeat(26)}` },
      { mode: "as_of", table: "expenses", row: `r_${"1".repeat(26)}`, as_of: 1 },
    ],
  },
  {
    name: "saveslot_pending",
    operation: "pending",
    scope: "saveslot.read",
    description: PENDING.description,
    params: {
      id: { schema: str, text: PENDING.params.id },
      slot: { schema: str, text: PENDING.params.slot },
      type: {
        schema: {
          enum: ["conflict", "awaiting_confirmation", "flagged", "schema_change", "deletion"],
        },
        text: PENDING.params.type,
      },
      status: {
        schema: { enum: ["open", "resolved", "superseded", "all"] },
        text: PENDING.params.status,
      },
      limit: { schema: limit(200), text: COMMON.limit },
      cursor,
      task,
    },
    withheld: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    examples: [{}, { slot: "ledger", status: "all", limit: 5 }, { id: `pi_${"1".repeat(16)}` }],
  },
  {
    name: "saveslot_write",
    operation: "write",
    scope: "saveslot.write",
    description: WRITE.description,
    params: {
      sv: { schema: { type: "integer", minimum: 1 }, text: WRITE.params.sv },
      evidence: { schema: { type: "array", items: SEGMENT }, text: WRITE.params.evidence },
      ops: {
        schema: { type: "array", minItems: 1, items: WRITE_OP },
        text: WRITE.params.ops,
        required: true,
      },
      idempotency_key: { schema: str, text: IDEMPOTENCY_KEY },
      task,
    },
    withheld: { mode: "jobs are not in this version (04-contract-types §0.2)" },
    refuse: (args) => {
      const ops = Array.isArray(args["ops"]) ? (args["ops"] as unknown[]) : [];
      for (const [i, op] of ops.entries()) {
        if (op !== null && typeof op === "object" && "acknowledge" in op) {
          return `ops/${i}/acknowledge`;
        }
        const at = levelIn((op as { evidence?: unknown } | null)?.evidence);
        if (at !== undefined) return `ops/${i}/evidence/${at}/level`;
      }
      const at = levelIn(args["evidence"]);
      return at !== undefined ? `evidence/${at}/level` : undefined;
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    examples: [
      {
        sv: 1,
        evidence: [{ kind: "user_message", text: "tea, 11-16" }],
        ops: [
          { intent: "insert", table: "ledger.expenses", set: { date: "2026-11-16", note: "tea" } },
        ],
        task: "examples",
      },
    ],
  },
  {
    name: "saveslot_resolve",
    operation: "resolve",
    // The service's rule for resolve (04-contract §6 gives a scope per decision).
    scope: "saveslot.write",
    description: RESOLVE.description,
    params: {
      id: { schema: str, text: RESOLVE.params.id, required: true },
      decision: {
        schema: {
          enum: [
            "keep_effective",
            "take_candidate",
            "take_previous",
            "confirm",
            "reject",
            "keep",
            "revoke",
            "cancel",
          ],
        },
        text: RESOLVE.params.decision,
        required: true,
      },
      item_ver: { schema: str, text: RESOLVE.params.item_ver },
      candidate: { schema: { type: "integer", minimum: 0 }, text: RESOLVE.params.candidate },
      note: { schema: str, text: RESOLVE.params.note },
      evidence: { schema: { type: "array", items: SEGMENT }, text: RESOLVE.params.evidence },
      evidence_by_field: { schema: BY_FIELD, text: RESOLVE.params.evidence_by_field },
      idempotency_key: { schema: str, text: IDEMPOTENCY_KEY },
      task,
    },
    withheld: {
      diff_upto: "migration differences are not in this version (04-contract-types §0.2)",
      rows: "migration differences are not in this version (04-contract-types §0.2)",
    },
    refuse: (args) => {
      const at = levelIn(args["evidence"]);
      return at !== undefined ? `evidence/${at}/level` : undefined;
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    examples: [
      { id: `pi_${"1".repeat(16)}`, decision: "confirm", item_ver: `iv_${"1".repeat(16)}.1.0` },
    ],
  },
  {
    name: "saveslot_schema_draft",
    operation: "schema_draft",
    scope: "saveslot.schema",
    description: SCHEMA_DRAFT.description,
    params: {
      document: { schema: { type: "object" }, text: SCHEMA_DRAFT.params.document, required: true },
      idempotency_key: { schema: str, text: DRAFT_IDEMPOTENCY_KEY },
      task,
    },
    withheld: {},
    // 05 §8: a draft is not destructive; submitting the same one again gives the same receipt.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    // The shape of a document only: its names say they are an example, not a table to copy.
    examples: [
      {
        document: {
          slot: "example_slot",
          base_version: null,
          timezone: "UTC",
          tables: [
            {
              name: "example_table",
              kind: "base",
              description: "an example: one row per happening",
              time: { type: "event", field: "day" },
              fields: [
                { name: "day", type: "date", required: true, description: "the day it happened" },
                { name: "what", type: "text", required: true, description: "what happened" },
              ],
            },
          ],
        },
        task: "examples",
      },
    ],
  },
];

/** The tools listed to `principal`. */
export function toolsFor(principal: Principal): readonly Tool[] {
  return TOOLS.filter((t) => principal.scopes.includes(t.scope));
}

/**
 * What `structuredContent` may be (05 §3): the operation's result, the contract's error, or an
 * elicitation's outcome. The result's own shape is not spelled out here: the contract's types are
 * not yet a schema this package can take.
 */
export const OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  anyOf: [
    {
      required: ["error"],
      properties: { error: { type: "object", required: ["code"], properties: { code: str } } },
    },
    {
      required: ["elicitation", "executed"],
      properties: { elicitation: { enum: ["declined", "cancelled"] }, executed: bool },
    },
    { not: { anyOf: [{ required: ["error"] }, { required: ["elicitation"] }] } },
  ],
};

/** A tool as `tools/list` gives it to a credential whose tools are `listed`. */
export function describe(tool: Tool, listed: ReadonlySet<ToolName>) {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, p] of Object.entries(tool.params)) {
    properties[name] = { ...p.schema, description: compose(p.text, listed) };
    if (p.required) required.push(name);
  }
  return {
    name: tool.name,
    description: compose(tool.description, listed),
    inputSchema: {
      type: "object" as const,
      properties,
      ...(required.length > 0 ? { required } : {}),
      ...(tool.oneOf !== undefined ? { oneOf: [...tool.oneOf] } : {}),
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: tool.annotations,
  };
}
