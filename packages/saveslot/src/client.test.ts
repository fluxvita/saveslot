// The client against a real service started by the service commands (06-cli §3 «分步做»; 05-surfaces
// §14): each operation the CLI calls goes over the socket as the user session and comes back as the
// contract's result, or as the contract's error.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Client,
  ContractCallError,
  createClient,
  resolveCredential,
  TransportError,
} from "@fluxvita/saveslot-cli/testing";
import { type CommandIO, serviceCommand, socketFile } from "@fluxvita/saveslot-daemon";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const root = mkdtempSync(join(tmpdir(), "saveslot-e2e-"));
const home = join(root, "home");
const quiet: CommandIO = { out: () => {}, err: () => {} };
let client: Client;

/** The spending template of 06-cli §3.1, as a slot `ledger`. */
const LEDGER = {
  slot: "ledger",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "expenses",
      kind: "base",
      description: "one row per expense",
      time: { type: "event", field: "date" },
      fields: [
        { name: "date", type: "date", required: true, description: "the day" },
        { name: "category", type: "text", required: true, description: "the category" },
        {
          name: "amount",
          type: "quantity",
          unit: "CNY",
          required: true,
          min: 0,
          description: "the amount",
        },
      ],
    },
  ],
};

beforeAll(async () => {
  expect(await serviceCommand("init", ["--home", home], quiet)).toBe(0);
  expect(await serviceCommand("start", ["--home", home], quiet)).toBe(0);
  const credential = await resolveCredential({ home, env: {} });
  expect(credential.kind).toBe("session");
  client = createClient({ socketPath: socketFile(home), token: credential.token });
});
afterAll(async () => {
  await serviceCommand("stop", ["--home", home], quiet);
  rmSync(root, { recursive: true, force: true });
});

describe("the client against the local service", () => {
  it("creates a slot and reads it back by catalog, query and the reads it left", async () => {
    const draft = await client.schemaDraft({ document: LEDGER, idempotency_key: "e2e-draft" });
    expect(draft.outcome).toBe("applied");

    const list = await client.catalog({ task: "e2e" });
    expect(list.slots.map((s) => s.slot)).toEqual(["ledger"]);
    const table = await client.catalog({ level: "table", tables: ["ledger.expenses"] });
    expect(table.tables.map((t) => t.table)).toEqual(["expenses"]);
    const schema = await client.catalog({ level: "schema", slot: "ledger" });
    expect(schema.document).toMatchObject({ slot: "ledger" });

    const q = await client.query({ table: "ledger.expenses" });
    expect(q.total).toBe(0);

    const pending = await client.pending({ slot: "ledger" });
    expect(pending.total).toBe(0);

    const verify = await client.logVerify();
    expect(verify).toMatchObject({
      chain: { intact: true },
      checksum_mismatch: [],
      index_mismatch: [],
    });

    // The catalog read under the task was recorded as the user's, with its task.
    await expect
      .poll(async () => (await client.readsList({ of_task: "e2e" })).total, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
  });

  it("sends a task in Chinese as UTF-8, and the service records it as given", async () => {
    const task = "整理账单 · 十一月";
    await client.catalog({ task });
    await expect
      .poll(async () => (await client.readsList({ of_task: task })).reads.map((r) => r.task), {
        timeout: 15_000,
      })
      .toContain(task);
  });

  it("issues, lists, renames and revokes a connection", async () => {
    const issued = await client.connections.issue({ name: "e2e · host" });
    expect(issued.token).toMatch(/^slt_/);
    const listed = await client.connections.list();
    expect(listed.connections.map((c) => c.id)).toContain(issued.id);
    const renamed = await client.connections.update({ id: issued.id, name: "e2e · renamed" });
    expect(renamed.name).toBe("e2e · renamed");
    const revoked = await client.connections.revoke({ id: issued.id });
    expect(revoked.state).toBe("revoked");
    const all = await client.connections.list({ include_revoked: true });
    expect(all.connections.find((c) => c.id === issued.id)?.state).toBe("revoked");
  });

  it("gives the contract's error as a ContractCallError, and an absent service as a TransportError", async () => {
    const e = await client.pending({ id: "pi_0000000000000000" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ContractCallError);
    expect((e as ContractCallError).code).toBe("not_found");

    const nowhere = createClient({ socketPath: join(root, "none.sock"), token: "x" });
    const t = await nowhere.logVerify().catch((x: unknown) => x);
    expect(t).toBeInstanceOf(TransportError);
    expect((t as TransportError).code).toBe("unreachable");
  });
});
