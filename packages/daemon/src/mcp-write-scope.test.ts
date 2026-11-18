// saveslot_write by a connection whose range is some slots, against a running service (04-contract
// «名字只在可见范围内解析»; 05-surfaces §6 `saveslot_write`): a name out of its range is answered as
// one that does not exist, and nothing in the text names a slot, table or field out of range; a
// table in range it cannot write yet (07-scope-v1) is answered as needing every slot in range.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalHome, sessionFile } from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import { httpDriver } from "./http-driver.fixture.ts";
import { mcpClient } from "./mcp-driver.fixture.ts";
import { type RunningService, runService } from "./service.ts";

const T = 60_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-mcp-write-scope-"));
const home = join(root, "home");
let session = "";
let service: RunningService | undefined;
let scoped = "";
const http = httpDriver(() => home);
const issue = async (params: Record<string, unknown>) =>
  ((await http(session, "connections.issue", params)) as { result: { token: string } }).result;

const doc = (slot: string, table: string, fields: string[]) => ({
  slot,
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: table,
      kind: "base",
      description: table,
      time: { type: "event", field: "date" },
      fields: [
        { name: "date", type: "date", required: true, description: "the day" },
        ...fields.map((f) => ({ name: f, type: "text", description: f })),
      ],
    },
  ],
});

type CallResult = { isError?: boolean; content: unknown; structuredContent?: unknown };
const textOf = (r: CallResult) =>
  ((r.content as { type: string; text: string }[])[0]?.text ?? "").replace(
    /untrusted-data-[0-9a-f]{32}/g,
    "untrusted-data-N",
  );
async function call(credential: string, name: string, args: Record<string, unknown>) {
  const c = await mcpClient(home, credential, "legacy");
  try {
    return (await c.callTool({ name, arguments: args })) as CallResult;
  } finally {
    await c.close();
  }
}

beforeAll(async () => {
  await initLocalHome({
    home,
    backend: testBackend(),
    lock: osFileLock,
    now: new Date().toISOString(),
  });
  session = readFileSync(sessionFile(home), "utf8").trim();
  service = await runService({ home, version: "t", signals: false, log: () => {} });
  const maker = (
    await issue({ name: "maker", scopes: ["saveslot.read", "saveslot.write", "saveslot.schema"] })
  ).token;
  for (const d of [
    doc("diet", "meals", ["what"]),
    doc("ledger", "meals", ["what"]),
    doc("secretplan", "hidden_table", ["hidden_field", "what"]),
  ]) {
    const r = await call(maker, "saveslot_schema_draft", { document: d });
    expect(r.isError ?? false).toBe(false);
  }
  scoped = (
    await issue({ name: "scoped", scopes: ["saveslot.read", "saveslot.write"], slots: ["diet"] })
  ).token;
}, T);
afterAll(async () => {
  await service?.stop();
  rmSync(root, { recursive: true, force: true });
}, T);

describe("saveslot_write by a connection scoped to one slot", () => {
  it(
    "names nothing out of its range, and a table in range needs every slot",
    async () => {
      const write = (table: string, set: Record<string, unknown>) =>
        call(scoped, "saveslot_write", { sv: 1, ops: [{ intent: "insert", table, set }] });
      const set = { date: "2026-11-05", what: "x" };
      const cases: [string, Record<string, unknown>, RegExp][] = [
        ["nothere.meals", set, /ledger|secretplan|hidden/],
        ["secretplan.nothere", set, /ledger|hidden_table|hidden_field/],
        ["secretplan.hidden_table", { date: "2026-11-05", hidden: "x" }, /ledger|hidden_field/],
        ["hidden_table", set, /ledger|secretplan|hidden_field/],
        ["meals", set, /ledger|secretplan|hidden/],
        ["diet.nothere", set, /ledger|secretplan|hidden/],
      ];
      for (const [table, values, out] of cases) {
        const r = await write(table, values);
        expect([table, r.isError]).toEqual([table, true]);
        expect([table, textOf(r)]).not.toEqual([table, expect.stringMatching(out)]);
      }
      const inRange = await write("diet.meals", set);
      expect(inRange.isError).toBe(true);
      expect(textOf(inRange)).toContain(
        "This needs a connection whose range is every slot; this connection reaches only some of them.",
      );
    },
    T,
  );
});
