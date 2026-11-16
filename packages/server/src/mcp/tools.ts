// The MCP tools and the contract operations they call (docs/zh-CN/spec/05-surfaces.md §1, §2,
// §8, §9.1). A tool is listed to a credential that has its scope (05 §1 «工具列表按 scope 裁剪»);
// its parameters are the operation's, less the ones MCP does not expose (05 §2), each of which is
// named in `withheld`.

import type { Operation, Principal, Scope } from "@fluxvita/saveslot-service";
import type { JSONObject } from "@modelcontextprotocol/server";
import type { ToolName } from "./names.ts";
import { CATALOG, COMMON, compose, QUERY, type Text } from "./texts.ts";

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
];

/** The tools listed to `principal`. */
export function toolsFor(principal: Principal): readonly Tool[] {
  return TOOLS.filter((t) => principal.scopes.includes(t.scope));
}

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
      additionalProperties: false,
    },
    annotations: tool.annotations,
  };
}
