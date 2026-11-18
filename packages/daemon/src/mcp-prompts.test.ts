// The server's `instructions` and its prompts against a running service (05-surfaces §9
// «服务器的 instructions», §10.1, §11): what each credential is given, in each protocol era,
// through the official client; that a `slot` argument outside the credential's range is answered
// as one that does not exist; and that neither the instructions nor a prompt records a read. The
// text of each version (and `track`, whose tool this version does not list) is in the server
// package's golden files.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalHome, sessionFile } from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import { LEDGER } from "./contract-suite.fixture.ts";
import { httpDriver } from "./http-driver.fixture.ts";
import { type Era, mcpClient } from "./mcp-driver.fixture.ts";
import { type RunningService, runService } from "./service.ts";

const T = 60_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-mcp-prompts-"));
const home = join(root, "home");
let session = "";
let service: RunningService | undefined;
/** Tokens of connection instances: every scope; read only; schema and its slot range one slot. */
const token = { all: "", reader: "", scoped: "" };

const http = httpDriver(() => home);
const issue = async (params: Record<string, unknown>) =>
  ((await http(session, "connections.issue", params)) as { result: { token: string } }).result
    .token;
/** The reads recorded so far. */
const reads = async () =>
  ((await http(session, "reads.list", { limit: 200 })) as { result: { reads: unknown[] } }).result
    .reads.length;

beforeAll(async () => {
  await initLocalHome({
    home,
    backend: testBackend(),
    lock: osFileLock,
    now: new Date().toISOString(),
  });
  session = readFileSync(sessionFile(home), "utf8").trim();
  service = await runService({ home, version: "t", signals: false, log: () => {} });
  for (const slot of ["ledger", "health"]) {
    expect(await http(session, "schema_draft", { document: { ...LEDGER, slot } })).toMatchObject({
      result: { outcome: "applied" },
    });
  }
  token.all = await issue({
    name: "all",
    scopes: ["saveslot.read", "saveslot.write", "saveslot.schema", "saveslot.delete"],
  });
  token.reader = await issue({ name: "reader", scopes: ["saveslot.read"] });
  token.scoped = await issue({
    name: "scoped",
    scopes: ["saveslot.read", "saveslot.write", "saveslot.schema"],
    slots: ["health"],
  });
}, T);
afterAll(async () => {
  await service?.stop();
  rmSync(root, { recursive: true, force: true });
}, T);

/** The text of a prompt's one message. */
const textOf = (r: { messages: { content: unknown }[] }) =>
  (r.messages[0]?.content as { text?: string } | undefined)?.text ?? "";

/** A client of `credential` in `era`: what it was given at the handshake, and the client. */
async function connect(credential: string, era: Era) {
  const c = await mcpClient(home, credential, era);
  return { c, instructions: c.getInstructions() ?? "", capabilities: c.getServerCapabilities() };
}

for (const era of ["legacy", "modern"] as const satisfies readonly Era[]) {
  describe(`instructions and prompts (${era === "legacy" ? "2025-11-25" : "2026-07-28"})`, () => {
    it("every scope: the paragraphs of the tools listed, the slots it sees by name; the prompts capability", async () => {
      const { c, instructions, capabilities } = await connect(token.all, era);
      const listed = await c.listPrompts();
      const track = await c.getPrompt({ name: "track", arguments: {} }).then(
        () => "given",
        (e: Error) => e.message,
      );
      await c.close();
      expect(capabilities?.prompts).toEqual({ listChanged: false });
      expect(instructions).toContain("When to write:");
      // Neither saveslot_schema_draft nor saveslot_delete is listed in this version: nothing
      // points to them, and track is not listed.
      expect(instructions).not.toContain("saveslot_schema_draft");
      expect(instructions).not.toContain("Before deleting,");
      expect(instructions.endsWith("health: 1 table\nledger: 1 table")).toBe(true);
      expect(listed.prompts.map((p) => p.name)).toEqual(["overview", "pending"]);
      expect(track).toContain("Unknown prompt");
    });

    it("read only: the read-only paragraph, no writing; overview and pending, no track", async () => {
      const { c, instructions } = await connect(token.reader, era);
      const listed = await c.listPrompts();
      const pending = await c.getPrompt({ name: "pending", arguments: {} });
      await c.close();
      expect(instructions).toContain("This connection can only read");
      expect(instructions).not.toContain("When to write:");
      expect(listed.prompts.map((p) => p.name)).toEqual(["overview", "pending"]);
      const text = textOf(pending);
      expect(text).toContain("this connection cannot resolve items");
      expect(text).not.toContain("saveslot_resolve");
    });

    it("a slot range of one slot: that slot only; another slot is answered as one that is not there", async () => {
      const { c, instructions } = await connect(token.scoped, era);
      const refused = (slot: string) =>
        c.getPrompt({ name: "pending", arguments: { slot } }).then(
          () => "given",
          (e: Error) => e.message,
        );
      const outside = await refused("ledger");
      const none = await refused("nosuch");
      const malformed = await refused("no-such");
      const inside = await c.getPrompt({ name: "pending", arguments: { slot: "health" } });
      await c.close();
      expect(
        instructions.endsWith(
          "This user's slots (names only, not descriptions; see their tables with saveslot_catalog):\nhealth: 1 table",
        ),
      ).toBe(true);
      // Outside its range, not there at all, or not a name: the same answer.
      expect(outside).toContain("slot is not a slot this connection can see");
      expect([none, malformed]).toEqual([outside, outside]);
      expect(textOf(inside)).toContain("in slot health");
    });
  });
}

it("neither the instructions nor a prompt records a read", async () => {
  const before = await reads();
  for (const era of ["legacy", "modern"] as const) {
    const { c } = await connect(token.scoped, era);
    await c.listPrompts();
    await c.getPrompt({ name: "overview", arguments: {} });
    await c.getPrompt({ name: "pending", arguments: { slot: "health" } });
    await c.close();
  }
  expect(await reads()).toBe(before);
});
