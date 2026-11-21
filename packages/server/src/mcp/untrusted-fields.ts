// The contract's UntrustedText (docs/zh-CN/spec/04-contract-types.md §1.4): every field typed so,
// by the interface it is in, and where MCP shows it. A test reads the spec and fails when a field
// typed UntrustedText is missing here, so the list cannot fall behind the contract by hand.
//
// Field values are untrusted by their type, not by a field of their own: a `text` value is
// UntrustedText (04-contract-types §1.4 `Value`). A result does not carry its fields' types, so
// every string value is shown as untrusted, whatever its shape, and a quantity's unit with it;
// numbers and booleans are not text (`fieldValue` in render.ts). A test puts a payload in every
// string of a result and finds it inside the boundary only (render.test.ts).

import type { ToolName } from "./names.ts";

/** Where a field is shown: on a tool, or nowhere in this version, and why. */
export type Shown = { readonly tool: ToolName } | { readonly not: string };

export const UNTRUSTED_FIELDS = {
  "Value.text": { tool: "saveslot_query" },
  "CatalogList.description": { tool: "saveslot_catalog" },
  "CatalogList.aliases": { tool: "saveslot_catalog" },
  "CatalogTables.description": { tool: "saveslot_catalog" },
  "CatalogTables.aliases": { tool: "saveslot_catalog" },
  "CatalogTables.examples": { tool: "saveslot_catalog" },
  "CatalogTables.sql": { tool: "saveslot_catalog" },
  "SourceRef.text": { tool: "saveslot_history" },
  "SourcesListResult.excerpt": { tool: "saveslot_sources" },
  "SourcesListResult.name": { tool: "saveslot_sources" },
  "SourcesGetResult.text": { tool: "saveslot_sources" },
  "SourcesGetResult.name": { tool: "saveslot_sources" },
  "SourcesGetResult.origin": { tool: "saveslot_sources" },
  "SourcesGetResult.excerpt": { tool: "saveslot_sources" },
  "ItemResolution.note": { tool: "saveslot_pending" },
  EntityKeyText: { tool: "saveslot_write" },
  "ResolveParams.note": {
    not: "a parameter: what the caller sends, shown back as ItemResolution.note",
  },
} as const satisfies Record<string, Shown>;

export type UntrustedField = keyof typeof UNTRUSTED_FIELDS;
