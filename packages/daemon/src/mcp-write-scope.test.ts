// saveslot_write by a connection whose range is some slots, against a running service (04-contract
// «名字只在可见范围内解析»; 05-surfaces §6 `saveslot_write`): a name out of its range is answered as
// one that does not exist, and nothing in the text names a slot, table or field out of range; a
// table in range is written as by any credential (03-data-model/04-write-and-read «可见范围 · 写入»),
// a bare name both in range and out of it naming the one in range.
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
let maker = "";
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

type CallResult = { isError?: boolean; content: unknown };
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
  maker = (
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
    "names nothing out of its range, and writes a table in range",
    async () => {
      const write = (table: string, set: Record<string, unknown>) =>
        call(scoped, "saveslot_write", {
          sv: 1,
          evidence: [{ kind: "user_message", text: `${set["what"]} for lunch` }],
          ops: [{ intent: "insert", table, set }],
        });
      const set = { date: "2026-11-05", what: "x" };
      const cases: [string, Record<string, unknown>, RegExp][] = [
        ["nothere.meals", set, /ledger|secretplan|hidden/],
        ["secretplan.nothere", set, /ledger|hidden_table|hidden_field/],
        ["secretplan.hidden_table", { date: "2026-11-05", hidden: "x" }, /ledger|hidden_field/],
        ["hidden_table", set, /ledger|secretplan|hidden_field/],
        ["diet.nothere", set, /ledger|secretplan|hidden/],
      ];
      for (const [table, values, out] of cases) {
        const r = await write(table, values);
        expect([table, r.isError]).toEqual([table, true]);
        expect([table, textOf(r)]).not.toEqual([table, expect.stringMatching(out)]);
      }
      // In range: "meals" is in "diet" and in "ledger"; for this connection it is "diet"'s.
      for (const [table, what] of [
        ["meals", "noodles"],
        ["diet.meals", "rice"],
      ] as const) {
        const r = await write(table, { date: "2026-11-05", what });
        expect([table, r.isError ?? false]).toEqual([table, false]);
        expect([table, textOf(r)]).not.toEqual([
          table,
          expect.stringMatching(/ledger|secretplan|hidden/),
        ]);
      }
      const read = async (credential: string, table: string) =>
        textOf(await call(credential, "saveslot_query", { table }));
      for (const what of ["noodles", "rice"]) {
        const tag = `<untrusted-data-N>${what}</untrusted-data-N>`;
        expect([what, await read(scoped, "diet.meals")]).toEqual([
          what,
          expect.stringContaining(tag),
        ]);
        expect([what, await read(maker, "ledger.meals")]).not.toEqual([
          what,
          expect.stringContaining(what),
        ]);
      }
    },
    T,
  );
});
