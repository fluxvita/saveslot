// The tools as `tools/list` gives them, for the kinds of credential there are, against golden files
// (05-surfaces §9, §9.1): each tool's description, its parameters' descriptions and its input
// schema. A change in what a model is told about a tool, the sentence asking it to show the user a
// draft before creating a slot among them, shows in review as a change of these files. Update them
// with `pnpm exec vitest run packages/server/src/mcp/descriptions.test.ts -u`. The files hold JSON
// as JSON.stringify writes it, named .txt so that the formatter leaves them as written.

import type { Principal } from "@fluxvita/saveslot-service";
import { expect, describe as group, it } from "vitest";
import { describe, toolsFor } from "./tools.ts";

const principal = (scopes: Principal["scopes"]): Principal => ({
  kind: "connection",
  actor: `ci_${"1".repeat(16)}`,
  scopes,
  visibility: { kind: "all" },
});

/** The kinds of credential: the default scopes, read only, read and schema, and every scope. */
const CREDENTIALS: [string, Principal["scopes"]][] = [
  ["default", ["saveslot.read", "saveslot.write", "saveslot.schema"]],
  ["read-only", ["saveslot.read"]],
  ["read-write", ["saveslot.read", "saveslot.write"]],
  ["read-schema", ["saveslot.read", "saveslot.schema"]],
  ["every-scope", ["saveslot.read", "saveslot.write", "saveslot.schema", "saveslot.delete"]],
];

group("tools/list for each kind of credential (golden)", () => {
  it.each(CREDENTIALS)("%s", async (name, scopes) => {
    const tools = toolsFor(principal(scopes));
    const listed = new Set(tools.map((t) => t.name));
    const list = tools.map((t) => describe(t, listed));
    await expect(`${JSON.stringify(list, null, 2)}\n`).toMatchFileSnapshot(
      `./__golden__/tools-list-${name}.txt`,
    );
  });
});
