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
  WRITE_OP_FIELDS,
} from "./texts.ts";

export type { ToolName };

type JsonSchema = JSONObject;

/** A parameter: its JSON Schema without the description, and the description's text. */
interface Param {
  readonly schema: JsonSchema;
  readonly text: Text;
  readonly required?: true;
  /** An array of objects: the description of each field of its items (`ops[]`: 05 §9). */
  readonly fields?: Readonly<Record<string, Text>>;
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
// Which fields go with which kind is said in each field's description, not by a `oneOf` per
// kind: a host may flatten or refuse alternatives inside an array's items. `source_ref` (and its
// `id`) is not taken in this version (05 §9 «这一版不出现的句子»).
const fileRefOnly = (what: string) => `${what} \`file_ref\` only.`;
const SEGMENT: JsonSchema = {
  type: "object",
  properties: {
    kind: { enum: ["user_message", "agent_note", "tool_result", "file_ref"] },
    text: {
      ...str,
      description:
        "Required for `user_message`, `agent_note` and `tool_result`; not with `file_ref`.",
    },
    stated_at: {
      ...str,
      description: "Any kind: when the words were said, a moment with its offset.",
    },
    name: { ...str, description: fileRefOnly("The file's name. Required, and for") },
    mime: { ...str, description: fileRefOnly("Its media type. Required, and for") },
    size: {
      type: "integer",
      minimum: 0,
      description: fileRefOnly("Its size in bytes. Required, and for"),
    },
    sha256: { ...str, description: fileRefOnly("Its SHA-256, 64 hex digits. Required, and for") },
    origin: { ...str, description: fileRefOnly("Where it came from. Optional, and for") },
    excerpt: { ...str, description: fileRefOnly("The part of it that matters. Optional, and for") },
  },
  required: ["kind"],
  additionalProperties: false,
};

const keyValues: JsonSchema = { type: "object" };

/**
 * A write op (04-contract-types §5.1 `WriteOp`), without `acknowledge` (05 §2), and without what
 * this version does not take.
 */
const WRITE_OP: JsonSchema = {
  type: "object",
  properties: {
    intent: { enum: ["insert", "update", "correct", "revoke"] },
    table: str,
    row: str,
    entity: str,
    entity_key: keyValues,
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
    // `external_key`, `as`, an op's own `evidence`, `evidence_by_field` and `premises` are not
    // taken in this version, and not listed (05 §9 «这一版不出现的句子»).
    evidence_refs: { type: "array", items: { type: "integer", minimum: 0 } },
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
      tables: {
        schema: { ...names, minItems: 1, maxItems: 10 },
        text: CATALOG.params.tables,
      },
      limit: { schema: limit(200), text: CATALOG.params.limit },
      cursor,
      task,
    },
    withheld: {
      draft: "reading a draft comes with changing a slot's schema (07-scope-v1 P4)",
    },
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
      detail: { schema: { enum: ["concise"] }, text: COMMON.detail },
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
      mode: { schema: { enum: ["timeline", "as_of"] }, text: HISTORY.params.mode },
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
      detail: { schema: { enum: ["concise"] }, text: COMMON.detail },
      limit: { schema: limit(200), text: COMMON.limit },
      cursor,
      task,
    },
    withheld: {
      external_key: "a read takes no source key (04-contract-types §1.5)",
      key: "05 §9.1 gives history no derived-row target",
      since: "only with mode `changes`, not in this version (07-scope-v1 P2)",
      until: "only with mode `changes`, not in this version (07-scope-v1 P2)",
    },
    oneOf: [
      {
        properties: { mode: { const: "timeline" } },
        not: { anyOf: ["as_of", "valid_at", "detail"].map((p) => ({ required: [p] })) },
      },
      {
        properties: { mode: { const: "as_of" } },
        required: ["mode", "as_of"],
        not: { anyOf: ["expand_sources"].map((p) => ({ required: [p] })) },
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
        fields: WRITE_OP_FIELDS,
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
          // This version's items are conflicts and changes awaiting confirmation; the other
          // decisions come with flagged items (P2), deletions (P3) and schema changes (P4).
          enum: ["keep_effective", "take_candidate", "take_previous", "confirm", "reject"],
        },
        text: RESOLVE.params.decision,
        required: true,
      },
      item_ver: { schema: str, text: RESOLVE.params.item_ver },
      candidate: { schema: { type: "integer", minimum: 0 }, text: RESOLVE.params.candidate },
      note: { schema: str, text: RESOLVE.params.note },
      evidence: { schema: { type: "array", items: SEGMENT }, text: RESOLVE.params.evidence },
      idempotency_key: { schema: str, text: IDEMPOTENCY_KEY },
      task,
    },
    withheld: {
      evidence_by_field: "not taken in this version (07-scope-v1 P2)",
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
 * An array's schema with each field of its items described: every field the items have must have
 * a text, and every text a field, so that a field added later is not left without one.
 */
function withFields(
  schema: JsonSchema,
  fields: Readonly<Record<string, Text>> | undefined,
  listed: ReadonlySet<ToolName>,
): JsonSchema {
  if (fields === undefined) return schema;
  const items = schema["items"] as JsonSchema;
  const props = items["properties"] as Record<string, JsonSchema>;
  const names = Object.keys(props);
  if (names.length !== Object.keys(fields).length || names.some((n) => !Object.hasOwn(fields, n)))
    throw new Error(`the fields described are not the items' fields: ${names.join(", ")}`);
  const described: Record<string, JsonSchema> = {};
  for (const n of names)
    described[n] = { ...props[n], description: compose(fields[n] as Text, listed) };
  return { ...schema, items: { ...items, properties: described } };
}

/** A tool as `tools/list` gives it to a credential whose tools are `listed`. */
export function describe(tool: Tool, listed: ReadonlySet<ToolName>) {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, p] of Object.entries(tool.params)) {
    properties[name] = {
      ...withFields(p.schema, p.fields, listed),
      description: compose(p.text, listed),
    };
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
    annotations: tool.annotations,
  };
}
