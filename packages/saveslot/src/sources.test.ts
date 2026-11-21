// `saveslot sources` against a real service (06-cli §4.7): the sources newest first with the
// start of their text, a search, one source with its text and what it produced; what was stored
// shown as untrusted text, a terminal's escape sequences in it escaped.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, resolveCredential } from "@fluxvita/saveslot-cli/testing";
import { type CommandIO, serviceCommand, socketFile } from "@fluxvita/saveslot-daemon";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatch } from "./dispatch.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const root = mkdtempSync(join(tmpdir(), "saveslot-sources-"));
const home = join(root, "home");
const quiet: CommandIO = { out: () => {}, err: () => {} };
const ESC = String.fromCodePoint(0x1b);
let token = "";
let row = "";

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

const post = (path: string, body: unknown) =>
  request({ socketPath: socketFile(home), method: "POST", path, token, body }) as Promise<
    Record<string, unknown>
  >;

beforeAll(async () => {
  expect((await saveslot("init")).code).toBe(0);
  expect((await saveslot("start")).code).toBe(0);
  token = (await resolveCredential({ home, env: {} })).token;
  await post("/v1/drafts", {
    document: {
      slot: "ledger",
      base_version: null,
      timezone: "Asia/Shanghai",
      tables: [
        {
          name: "lunch",
          kind: "base",
          description: "one row per lunch",
          time: { type: "none" },
          fields: [{ name: "note", type: "text", required: true, description: "what" }],
        },
      ],
    },
  });
  const w = (await post("/v1/writes", {
    sv: 1,
    evidence: [{ kind: "user_message", text: "noodles for lunch" }],
    ops: [{ intent: "insert", table: "ledger.lunch", set: { note: "noodles" } }],
  })) as { ops: { target: { row: string } }[] };
  row = w.ops[0]?.target.row as string;
  await post("/v1/writes", {
    sv: 1,
    evidence: [{ kind: "user_message", text: `then tea ${ESC}[2J cleared` }],
    ops: [{ intent: "insert", table: "ledger.lunch", set: { note: "tea" } }],
  });
});

afterAll(async () => {
  await serviceCommand("stop", ["--home", home], quiet);
  rmSync(root, { recursive: true, force: true });
});

describe("saveslot sources", () => {
  it("lists them newest first, the start of each text in the boundary; --json is the contract's", async () => {
    const r = await saveslot("sources");
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split("\n");
    expect(lines[0]).toBe("2 sources");
    expect(lines[1]).toMatch(/^s_\S+ user_message · ledger · .* · 「then tea \\x1b\[2J cleared」$/);
    expect(lines[2]).toMatch(/「noodles for lunch」$/);
    expect(r.out).not.toContain(ESC);
    const j = await saveslot("sources", "--json", "--limit", "1");
    const parsed = JSON.parse(j.out) as { mode: string; sources: unknown[]; next_cursor?: string };
    expect(parsed.mode).toBe("list");
    expect(parsed.sources).toHaveLength(1);
    expect(typeof parsed.next_cursor).toBe("string");
  });

  it("--kind, --from and --to filter the list and the search", async () => {
    const ids = async (...argv: string[]) => {
      const r = await saveslot("sources", ...argv, "--json");
      expect(r.code).toBe(0);
      return (JSON.parse(r.out) as { sources: unknown[] }).sources.length;
    };
    expect(await ids("--kind", "user_message")).toBe(2);
    expect(await ids("--kind", "file_ref")).toBe(0);
    expect(await ids("--from", "2000-01-01T00:00:00Z")).toBe(2);
    expect(await ids("--from", "2999-01-01T00:00:00Z")).toBe(0);
    expect(await ids("--to", "2000-01-01T00:00:00Z")).toBe(0);
    expect(await ids("--to", "2999-01-01T00:00:00Z")).toBe(2);
    expect(await ids("search", "noodles", "--kind", "file_ref")).toBe(0);
    expect(await ids("search", "noodles", "--kind", "user_message")).toBe(1);
    // A kind the contract does not have: the service refuses it (invalid_argument, 5).
    expect((await saveslot("sources", "--kind", "nonsense")).code).toBe(5);
  });

  it("search: the words as one text; none given is a usage error", async () => {
    const r = await saveslot("sources", "search", "NOODLES", "for");
    expect(r.code).toBe(0);
    expect(r.out).toContain("「noodles for lunch」");
    expect(r.out).not.toContain("then tea");
    expect((await saveslot("sources", "search")).code).toBe(2);
  });

  it("get: its text and what it produced; a source that is not there is not_found, 4", async () => {
    const list = JSON.parse((await saveslot("sources", "--json")).out) as {
      sources: { id: string; excerpt: string }[];
    };
    const id = list.sources.find((x) => x.excerpt === "noodles for lunch")?.id as string;
    const r = await saveslot("sources", "get", id);
    expect(r.code).toBe(0);
    expect(r.out).toContain("  text 「noodles for lunch」");
    expect(r.out).toContain(`ledger.lunch ${row}`);
    expect(r.out).toContain("note as value source");
    const none = await saveslot("sources", "get", `s_${"9".repeat(16)}`);
    expect(none.code).toBe(4);
    expect(none.err).toContain("not_found");
    expect((await saveslot("sources", "get")).code).toBe(2);
  });
});
