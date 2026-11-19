// The MCP tools against the contract: each tool's parameters are its operation's (04-contract-types,
// read from the spec itself) less the ones named as not exposed (05-surfaces §2), so a parameter
// added to the contract fails here until the tool takes it or says why not; its examples hold to
// its own schema; a sentence naming another tool appears only when that tool is listed (05 §9);
// a call of a tool the credential has no scope for is found before the SDK (05 §1).

import { readFileSync } from "node:fs";
import type { Principal } from "@fluxvita/saveslot-service";
import { fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";
import { expect, describe as group, it } from "vitest";
import { boundaryNumber } from "./boundary.ts";
import { missingScope, sdkHeaders } from "./handler.ts";
import { compose } from "./texts.ts";
import { describe, TOOLS, type ToolName, toolsFor } from "./tools.ts";
import { UNTRUSTED_FIELDS } from "./untrusted-fields.ts";

const SPEC = readFileSync(
  new URL("../../../../docs/zh-CN/spec/04-contract-types.md", import.meta.url),
  "utf8",
);

/** What a type extends: another, less some of its fields (`Omit<X, "a" | "b">`). */
interface Ext {
  readonly name: string;
  readonly omit: readonly string[];
}

/**
 * The spec's TypeScript: each interface's top-level fields and what it extends, and each union
 * of interfaces (`type X = A | B`).
 */
function interfaces(md: string): Map<string, { fields: string[]; extends: Ext[] }> {
  const out = new Map<string, { fields: string[]; extends: Ext[] }>();
  for (const block of md.matchAll(/```ts\n([\s\S]*?)```/g)) {
    const lines = (block[1] ?? "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const union = /^type (\w+) = (\w+(?: \| \w+)+);/.exec(lines[i] ?? "");
      if (union !== null) {
        const parts = (union[2] ?? "").split(" | ").map((name) => ({ name, omit: [] }));
        out.set(union[1] ?? "", { fields: [], extends: parts });
        continue;
      }
      const head = /^interface (\w+)(?: extends (.+?))? \{(.*)$/.exec(lines[i] ?? "");
      if (head === null) continue;
      const fields: string[] = [];
      const inline = head[3] ?? "";
      if (inline.includes("}")) {
        for (const f of inline.matchAll(/(\w+)\??:/g)) fields.push(f[1] ?? "");
      } else {
        for (i++; i < lines.length && !/^\}/.test(lines[i] ?? ""); i++) {
          const f = /^ {2}(\w+)\??:/.exec(lines[i] ?? "");
          if (f !== null) fields.push(f[1] ?? "");
        }
      }
      const ext: Ext[] = [];
      for (const m of (head[2] ?? "").matchAll(/Omit<(\w+), ([^>]+)>|(\w+)/g)) {
        if (m[1] !== undefined) {
          ext.push({
            name: m[1],
            omit: [...(m[2] ?? "").matchAll(/"(\w+)"/g)].map((x) => x[1] ?? ""),
          });
        } else if (m[3] !== undefined) ext.push({ name: m[3], omit: [] });
      }
      out.set(head[1] ?? "", { fields, extends: ext });
    }
  }
  return out;
}

const SPEC_TYPES = interfaces(SPEC);

/** Every parameter of an interface or union, with what it extends. */
function paramsOf(name: string): Set<string> {
  const t = SPEC_TYPES.get(name);
  if (t === undefined) throw new Error(`${name} is not in 04-contract-types`);
  return new Set([
    ...t.fields,
    ...t.extends.flatMap((e) => [...paramsOf(e.name)].filter((p) => !e.omit.includes(p))),
  ]);
}

const paramsType = (operation: string) =>
  `${operation.replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase())}Params`;

group("each tool's parameters are its operation's", () => {
  it("the spec's interfaces are read (the parser finds what it is checked on)", () => {
    expect([...paramsOf("CommonParams")]).toEqual(["task"]);
    expect([...paramsOf("PageParams")].sort()).toEqual(["cursor", "limit"]);
    expect(paramsOf("QueryParams").has("valid_during")).toBe(true);
    // A union, and an Omit<…> among what an interface extends.
    expect(paramsOf("HistoryParams").has("since")).toBe(true);
    expect(paramsOf("ResolveParams").has("evidence_by_field")).toBe(true);
    expect(paramsOf("ResolveParams").has("evidence_refs")).toBe(false);
  });

  it.each(TOOLS.map((t) => [t.name, t] as const))(
    "%s: every contract parameter exposed or named as withheld, nothing else",
    (_, tool) => {
      const contract = paramsOf(paramsType(tool.operation));
      const exposed = Object.keys(tool.params);
      const withheld = Object.keys(tool.withheld);
      expect({ unknown: exposed.filter((p) => !contract.has(p)) }).toEqual({ unknown: [] });
      expect({ withheldUnknown: withheld.filter((p) => !contract.has(p)) }).toEqual({
        withheldUnknown: [],
      });
      expect({
        neither: [...contract].filter((p) => !exposed.includes(p) && !withheld.includes(p)),
      }).toEqual({ neither: [] });
      expect(exposed.filter((p) => withheld.includes(p))).toEqual([]);
    },
  );

  it.each(TOOLS.flatMap((t) => t.examples.map((e) => [t.name, e, t] as const)))(
    "%s: the example %j holds to the tool's schema",
    async (_, example, tool) => {
      const { inputSchema } = describe(tool, new Set(TOOLS.map((t) => t.name)));
      const schema = fromJsonSchema(inputSchema as unknown as JsonSchemaType);
      const r = await schema["~standard"].validate(example);
      expect(r.issues).toBeUndefined();
    },
  );

  it("history: each mode with its own parameters only (05 §2)", async () => {
    const tool = TOOLS.find((t) => t.name === "saveslot_history");
    if (tool === undefined) throw new Error("no saveslot_history");
    const { inputSchema } = describe(tool, new Set());
    const schema = fromJsonSchema(inputSchema as unknown as JsonSchemaType);
    const ok = async (v: unknown) => (await schema["~standard"].validate(v)).issues === undefined;
    const r = `r_${"1".repeat(26)}`;
    expect(await ok({ table: "t", row: r, expand_sources: true })).toBe(true);
    expect(await ok({ table: "t", row: r, since: 3 })).toBe(false);
    expect(await ok({ mode: "as_of", table: "t", row: r })).toBe(false);
    expect(await ok({ mode: "as_of", table: "t", row: r, as_of: { task: "x" } })).toBe(true);
    expect(await ok({ mode: "as_of", table: "t", row: r, as_of: 3, until: 4 })).toBe(false);
    // `changes` is not in this version: neither the mode nor its parameters are listed.
    expect(await ok({ mode: "changes", table: "t", since: "my_last_read" })).toBe(false);
    expect(await ok({ mode: "composition", table: "t" })).toBe(false);
  });

  it("a parameter that is not the tool's is refused by the schema", async () => {
    const tool = TOOLS.find((t) => t.name === "saveslot_query");
    if (tool === undefined) throw new Error("no saveslot_query");
    const { inputSchema } = describe(tool, new Set());
    const schema = fromJsonSchema(inputSchema as unknown as JsonSchemaType);
    expect((await schema["~standard"].validate({ table: "t", position: 1 })).issues).toBeDefined();
    expect((await schema["~standard"].validate({})).issues).toBeDefined();
  });
});

group("static text", () => {
  it("a sentence naming another tool appears only when that tool is listed", () => {
    const text = ["One.", { text: "Use saveslot_sql.", needs: "saveslot_sql" as ToolName }];
    expect(compose(text, new Set())).toBe("One.");
    expect(compose(text, new Set<ToolName>(["saveslot_sql"]))).toBe("One. Use saveslot_sql.");
  });

  it("no listed text names a tool the credential is not listed", () => {
    const all: ToolName[] = [
      "saveslot_catalog",
      "saveslot_query",
      "saveslot_sql",
      "saveslot_history",
      "saveslot_sources",
      "saveslot_pending",
      "saveslot_write",
      "saveslot_resolve",
      "saveslot_schema_draft",
      "saveslot_delete",
    ];
    const listed = new Set(TOOLS.map((t) => t.name));
    for (const tool of TOOLS) {
      const text = JSON.stringify(describe(tool, listed));
      for (const name of all.filter((n) => !listed.has(n))) {
        expect({ tool: tool.name, names: text.includes(name) ? name : null }).toEqual({
          tool: tool.name,
          names: null,
        });
      }
    }
  });

  it("each tool description at most 4,096 characters (05 §4.3)", () => {
    const listed = new Set(TOOLS.map((t) => t.name));
    for (const tool of TOOLS) {
      expect(describe(tool, listed).description.length).toBeLessThanOrEqual(4096);
    }
  });
});

group("scope", () => {
  const principal = (scopes: Principal["scopes"]): Principal => ({
    kind: "connection",
    actor: `ci_${"1".repeat(16)}`,
    scopes,
    visibility: { kind: "all" },
  });
  const call = (name: string) => ({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name },
  });

  it("a tool is listed to a credential with its scope", () => {
    expect(toolsFor(principal(["saveslot.read"])).map((t) => t.name)).toEqual([
      "saveslot_catalog",
      "saveslot_query",
      "saveslot_history",
      "saveslot_pending",
    ]);
    expect(toolsFor(principal(["saveslot.read", "saveslot.write"])).map((t) => t.name)).toEqual([
      "saveslot_catalog",
      "saveslot_query",
      "saveslot_history",
      "saveslot_pending",
      "saveslot_write",
      "saveslot_resolve",
    ]);
    expect(toolsFor(principal([]))).toEqual([]);
  });

  it("a call of a tool without its scope needs that scope; anything else needs nothing", () => {
    expect(missingScope(call("saveslot_query"), principal(["saveslot.write"]))).toBe(
      "saveslot.read",
    );
    expect(missingScope(call("saveslot_query"), principal(["saveslot.read"]))).toBeUndefined();
    // No tool by that name: the protocol's error, from the server, not a 403.
    expect(missingScope(call("saveslot_nothing"), principal([]))).toBeUndefined();
    expect(missingScope({ method: "tools/list" }, principal([]))).toBeUndefined();
    expect(missingScope("not json-rpc", principal([]))).toBeUndefined();
    expect(missingScope([{ method: "tools/list" }, call("saveslot_catalog")], principal([]))).toBe(
      "saveslot.read",
    );
  });
});

group("what the SDK is given", () => {
  it("the protocol's headers, never the credential or anything else", () => {
    const h = sdkHeaders({
      authorization: `Bearer slt_${"A".repeat(43)}`,
      cookie: "c=1",
      host: "local",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "x-task-id": "t",
    });
    expect([...h.keys()].sort()).toEqual([
      "accept",
      "content-type",
      "mcp-method",
      "mcp-protocol-version",
    ]);
  });
});

group("the untrusted boundary (05 §5)", () => {
  it("a number the content holds is drawn again", () => {
    const draws = ["b".repeat(32), "c".repeat(32)];
    const n = boundaryNumber([`x${"b".repeat(32)}x`], () => draws.shift() ?? "");
    expect(n).toBe("c".repeat(32));
  });

  it("a number is 128 random bits in 32 lowercase hex digits", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const n = boundaryNumber([]);
      expect(n).toMatch(/^[0-9a-f]{32}$/);
      seen.add(n);
    }
    expect(seen.size).toBe(100);
    expect(() => boundaryNumber([], () => "A".repeat(32))).toThrow();
  });
});

group("UntrustedText (04-contract-types §1.4)", () => {
  /** Every field typed UntrustedText in the spec's TypeScript, as Interface.field. */
  function untrustedInSpec(md: string): Set<string> {
    const out = new Set<string>();
    for (const block of md.matchAll(/```ts\n([\s\S]*?)```/g)) {
      let current = "";
      for (const line of (block[1] ?? "").split("\n")) {
        const head = /^(?:interface|type) (\w+)/.exec(line);
        if (head !== null) current = head[1] ?? "";
        const code = line.replace(/\/\/.*$/, "");
        if (/^\s*(\/\*\*|\*)/.test(code)) continue;
        if (/^type UntrustedText\b/.test(code)) continue;
        if (/^type \w+ = UntrustedText\b/.test(code)) {
          out.add(current);
          continue;
        }
        for (const m of code.matchAll(/(\w+)\??:\s*UntrustedText\b/g))
          out.add(`${current}.${m[1]}`);
      }
    }
    return out;
  }

  it("every field the spec types UntrustedText is in the table, and nothing else", () => {
    const spec = untrustedInSpec(SPEC);
    // Read where the parser is checked: a field, a nested field, a type alias.
    expect(spec.has("CatalogList.description")).toBe(true);
    expect(spec.has("SourcesGetResult.origin")).toBe(true);
    expect(spec.has("EntityKeyText")).toBe(true);
    // Field values: by the comment on Value, not a field of their own.
    expect(SPEC).toMatch(/text → string（返回时是 UntrustedText）/);
    const table = new Set(Object.keys(UNTRUSTED_FIELDS).filter((k) => k !== "Value.text"));
    expect({ missing: [...spec].filter((k) => !table.has(k)) }).toEqual({ missing: [] });
    expect({ extra: [...table].filter((k) => !spec.has(k)) }).toEqual({ extra: [] });
  });
});

group("no outputSchema (05 §3)", () => {
  it("no tool declares one, for any set of scopes: a tool result is text only", () => {
    const scopes = [
      "saveslot.read",
      "saveslot.write",
      "saveslot.schema",
      "saveslot.delete",
    ] as const;
    for (let mask = 0; mask < 1 << scopes.length; mask++) {
      const listed = new Set(TOOLS.map((t) => t.name));
      const principal = {
        kind: "connection",
        actor: `ci_${"0".repeat(26)}`,
        scopes: scopes.filter((_, i) => (mask & (1 << i)) !== 0),
        visibility: { kind: "all" },
      } as unknown as Principal;
      for (const tool of toolsFor(principal)) {
        expect(Object.keys(describe(tool, listed))).not.toContain("outputSchema");
      }
    }
  });
});
