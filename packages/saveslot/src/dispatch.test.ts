// The `saveslot` command line against a real service (02-architecture §11; 06-cli §3 «分步做», §4):
// the service commands go to the daemon, the others to the CLI, which reads the slot it is asked
// for as the user session.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, resolveCredential } from "@fluxvita/saveslot-cli/testing";
import { type CommandIO, serviceCommand, socketFile } from "@fluxvita/saveslot-daemon";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatch } from "./dispatch.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const root = mkdtempSync(join(tmpdir(), "saveslot-dispatch-"));
const home = join(root, "home");
const quiet: CommandIO = { out: () => {}, err: () => {} };

async function saveslot(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await dispatch(
    [...argv, "--home", home],
    { NO_COLOR: "1" },
    {
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
      stdoutIsTTY: true,
      stderrIsTTY: true,
    },
  );
  return { code, out, err };
}

beforeAll(async () => {
  // Through the dispatcher: the service commands are the daemon's.
  expect((await saveslot("init")).code).toBe(0);
  expect((await saveslot("start")).code).toBe(0);
  const { token } = await resolveCredential({ home, env: {} });
  await createClient({ socketPath: socketFile(home), token }).schemaDraft({
    document: {
      slot: "health",
      base_version: null,
      timezone: "Asia/Shanghai",
      tables: [
        {
          name: "runs",
          kind: "base",
          description: "one row per run",
          time: { type: "event", field: "date" },
          fields: [{ name: "date", type: "date", required: true, description: "the day" }],
        },
      ],
    },
  } as never);
});

afterAll(async () => {
  await serviceCommand("stop", ["--home", home], quiet);
  rmSync(root, { recursive: true, force: true });
});

describe("saveslot", () => {
  it("status is the daemon's", async () => {
    const r = await saveslot("status");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^saveslot service: ready/);
  });

  it("slot list is the CLI's, as the user session: the slot and its table", async () => {
    const r = await saveslot("slot", "list");
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      "health · schema v1 · 「Asia/Shanghai」",
      "  runs  「one row per run」",
      "",
    ]);
  });

  it("slot list --json: the contract's result", async () => {
    const r = await saveslot("slot", "list", "--json");
    expect(JSON.parse(r.out)).toMatchObject({
      level: "list",
      slots: [{ slot: "health", sv: 1, tables: [{ table: "runs", kind: "base" }] }],
    });
  });

  // Only a usage error: anything further would run launchctl or systemctl (./autostart.test.ts).
  it("service is the daemon's", async () => {
    const r = await saveslot("service", "restart");
    expect(r.code).toBe(2);
    expect(r.err).toContain("saveslot service install | uninstall");
  });

  it("schema templates, and a command that is neither's", async () => {
    expect((await saveslot("schema", "templates")).out).toMatch(/^running /);
    const r = await saveslot("nope");
    expect(r.code).toBe(2);
  });
});
