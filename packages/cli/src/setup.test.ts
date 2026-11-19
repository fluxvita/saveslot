// `setup` (06-cli §3.3) where the service misbehaves, against a stand-in service with the daemon's
// steps stubbed: the self-check refused, the revocation failing. The real service is the entry
// package's tests'. And `entryHolds`, the one reading of a host's look-up output.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entryHolds } from "./connect.ts";
import { run } from "./run.ts";
import type { SetupServices } from "./setup.ts";

const SESSION = `sls_${"S".repeat(43)}`;
const NEW = `slt_${"N".repeat(43)}`;
const ID = "ci_01JF0000000000000000000000";
const root = mkdtempSync(join(tmpdir(), "saveslot-setup-cli-"));
const home = join(root, "home");
const hosts = join(root, "hosts");
const entry = join(root, "bin", "saveslot");
let answer: (req: IncomingMessage, res: ServerResponse) => void;
const seen: string[] = [];
let server: Server;

const json = (res: ServerResponse, status: number, v: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));

const services: SetupServices = {
  initialized: async () => true,
  init: async () => 0,
  start: async () => ({ exit: 0, started: false }),
  homeProblem: async () => undefined,
  lock: async () => ({ release: async () => {} }),
};

beforeAll(async () => {
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "credentials"), { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  writeFileSync(join(home, "credentials", "session"), SESSION, { mode: 0o600 });
  mkdirSync(hosts);
  mkdirSync(join(root, "bin"));
  writeFileSync(entry, "#!/bin/sh\n", { mode: 0o755 });
  // A host found, without an entry; its add would succeed (it is not reached).
  writeFileSync(
    join(hosts, "codex"),
    '#!/bin/sh\ncase "$1" in --version) echo "codex 9"; exit 0 ;; esac\n[ "$2" = get ] && exit 1\nexit 0\n',
    { mode: 0o755 },
  );
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push(
        `${req.method} ${(req.url ?? "").split("?")[0]} ${String(req.headers["authorization"]).slice(7, 11)}`,
      );
      answer(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(join(home, "run", "saveslot.sock"), r));
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

/** The stand-in: a slot there, no connections; the issue; the new token refused; the revocation. */
function service(revoke: [number, unknown]) {
  answer = (req, res) => {
    const auth = String(req.headers["authorization"] ?? "");
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/v1/slots") {
      if (auth.includes("slt_"))
        return json(res, 401, { error: { code: "unauthenticated", message: "no" } });
      return json(res, 200, { level: "list", total: 1, slots: [{ slot: "health", tables: [] }] });
    }
    if (req.method === "GET" && path === "/v1/connections")
      return json(res, 200, { connections: [], total: 0 });
    if (req.method === "POST" && path === "/v1/connections") {
      return json(res, 200, {
        id: ID,
        name: "t · Codex",
        scopes: ["saveslot.read", "saveslot.write"],
        via: "token",
        created_at: "2026-11-18T10:00:00Z",
        token: NEW,
      });
    }
    if (req.method === "DELETE") return json(res, ...revoke);
    json(res, 404, { error: { code: "not_found", message: "no route" } });
  };
}

async function setup() {
  let out = "";
  let err = "";
  const code = await run(
    ["--home", home, "setup", "--yes", "--host", "codex", "--json"],
    { PATH: hosts },
    {
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
      stdoutIsTTY: false,
      stderrIsTTY: false,
      entry,
      hostname: "t",
      platform: "darwin",
      watchSignals: () => () => {},
    },
    services,
  );
  return { code, out, err };
}

describe("setup: the new instance's self-check refused", () => {
  it("revoked: failed, self_check_failed, the instance revoked; no token; 1", async () => {
    service([
      200,
      { id: ID, name: "t · Codex", scopes: [], via: "token", created_at: "x", state: "revoked" },
    ]);
    seen.length = 0;
    const r = await setup();
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).hosts).toEqual([
      {
        host: "codex",
        state: "failed",
        reason: "self_check_failed",
        connection: { id: ID, name: "t · Codex", state: "revoked" },
      },
    ]);
    expect(seen).toContain(`DELETE /v1/connections/${ID} sls_`);
    expect(`${r.out}${r.err}`).not.toContain("slt_");
  });

  it("and the revocation fails: the instance said to be live; 1", async () => {
    service([503, { error: { code: "unavailable", message: "down" } }]);
    const r = await setup();
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).hosts[0]).toMatchObject({
      reason: "self_check_failed",
      connection: { state: "live" },
    });
    expect(`${r.out}${r.err}`).not.toContain("slt_");
  });
});

describe("setup: a signal, and then another failure", () => {
  it("init fails after SIGINT came: said as init's failure (1, initialized failed), not as stopped", async () => {
    let fire: ((s: "SIGINT") => void) | undefined;
    let out = "";
    const code = await run(
      ["--home", join(root, "fresh"), "setup", "--yes", "--json"],
      { PATH: hosts },
      {
        out: (s) => {
          out += s;
        },
        err: () => {},
        stdoutIsTTY: false,
        stderrIsTTY: false,
        entry,
        hostname: "t",
        platform: "darwin",
        watchSignals: (on) => {
          fire = on;
          return () => {
            fire = undefined;
          };
        },
      },
      {
        ...services,
        initialized: async () => false,
        // The signal comes while init runs; init then fails on its own.
        init: async () => {
          fire?.("SIGINT");
          return 1;
        },
      },
    );
    expect(code).toBe(1);
    expect(JSON.parse(out)).toEqual({ initialized: "failed" });
  });
});

describe("entryHolds: the path with no path character either side, escapes taken out (the review's table)", () => {
  const P = "/usr/local/bin/saveslot";
  const ESC = String.fromCodePoint(0x1b);
  it.each([
    ["path at end of output", `Command: ${P}`, P, true],
    ["then space", `${P} mcp`, P, true],
    ["then tab", `${P}\tmcp`, P, true],
    ["then newline", `Command: ${P}\nArgs: mcp\n`, P, true],
    ["then CRLF", `Command: ${P}\r\nArgs: mcp\r\n`, P, true],
    ["in double quotes (JSON)", `{"command":"${P}","args":["mcp"]}`, P, true],
    ["in single quotes", `command = '${P}'`, P, true],
    ["then -old", `Command: ${P}-old\n`, P, false],
    ["then /x", `Command: ${P}/x\n`, P, false],
    ["then .bak", `Command: ${P}.bak\n`, P, false],
    ["inside a longer path (prefix)", `Command: /opt${P}\n`, P, false],
    ["prefix match first, real one later", `Old: ${P}-old\nCommand: ${P}\n`, P, true],
    ["then comma", `command: ${P}, args: mcp`, P, true],
    ["then )", `saveslot (${P}) mcp`, P, true],
    ["then ]", `[${P}]`, P, true],
    ["then ;", `${P}; mcp`, P, true],
    ["then backtick", `\`${P}\``, P, true],
    ["ANSI reset right after the path", `Command: ${ESC}[36m${P}${ESC}[0m\n`, P, true],
    ["ANSI: path, space, then colour", `Command: ${ESC}[36m${P} ${ESC}[0mmcp\n`, P, true],
    [
      "path with a space, shown raw",
      "Command: /Users/a b/bin/saveslot\n",
      "/Users/a b/bin/saveslot",
      true,
    ],
    [
      "path with a space, JSON",
      '"command": "/Users/a b/bin/saveslot"',
      "/Users/a b/bin/saveslot",
      true,
    ],
    [
      "regex-special characters in the path",
      "Command: /opt/a+b(1)[x]$/saveslot\n",
      "/opt/a+b(1)[x]$/saveslot",
      true,
    ],
    [
      "regex-special: dot must not match any char",
      "Command: /opt/aXb/saveslot\n",
      "/opt/a.b/saveslot",
      false,
    ],
    ["path is a prefix of the token env line only", `Env: X=${P}xyz\n`, P, false],
    ["after ~ (a longer path)", `Command: ~${P}\n`, P, false],
    ["then +x", `Command: ${P}+x\n`, P, false],
    ["then @2", `Command: ${P}@2\n`, P, false],
    ["then ~ (a backup)", `Command: ${P}~\n`, P, false],
    ["empty output", "", P, false],
    // Shown another way: not seen. Real hosts print the path as it was added (no link resolved,
    // no ~, no quoting or escaping; Claude Code 2.1.327 and Codex 0.167.2, issue #29), so these
    // shapes stay not seen.
    [
      "(not a real host shape) path with a space, shell-quoted with a backslash",
      "Command: /Users/a\\ b/bin/saveslot\n",
      "/Users/a b/bin/saveslot",
      false,
    ],
    [
      "(not a real host shape) path with a quote, JSON-escaped",
      '"command": "/tmp/a\\"b/saveslot"',
      '/tmp/a"b/saveslot',
      false,
    ],
    [
      "(not a real host shape) a symbolic link resolved",
      "Command: /opt/homebrew/Cellar/x/bin/saveslot\n",
      P,
      false,
    ],
    [
      "(not a real host shape) ~ for the home",
      "Command: ~/bin/saveslot\n",
      "/Users/u/bin/saveslot",
      false,
    ],
    [
      "(not checked on a real host) NFC written, NFD shown",
      `Command: /Users/jose${String.fromCodePoint(0x301)}/bin/saveslot\n`,
      `/Users/jos${String.fromCodePoint(0xe9)}/bin/saveslot`,
      false,
    ],
  ])("%s", (_, out, path, holds) => {
    expect(entryHolds(out, path)).toBe(holds);
  });
  // What `claude mcp get` / `codex mcp get` print for an entry, through a pipe with NO_COLOR=1
  // (issue #29). Claude's look-up starts the server; a status line comes first, with a non-ASCII
  // mark that NO_COLOR keeps.
  const claudeGet = (path: string) =>
    [
      "saveslot:",
      "  Scope: User config (available in all your projects)",
      "  Status: \u2718 Failed to connect",
      `  Issue: ENOENT: no such file or directory, posix_spawn '${path}'`,
      "  Type: stdio",
      `  Command: ${path}`,
      "  Args: mcp",
      "  Environment:",
      `    SAVESLOT_TOKEN=slt_${"A".repeat(43)}`,
      "",
      "To remove this server, run: claude mcp remove saveslot -s user",
      "",
    ].join("\n");
  const codexGet = (path: string) =>
    [
      "saveslot",
      "  enabled: true",
      "  transport: stdio",
      `  command: ${path}`,
      "  args: mcp",
      "  cwd: -",
      "  env: SAVESLOT_TOKEN=*****",
      "  remove: codex mcp remove saveslot",
      "",
    ].join("\n");
  it.each([
    [
      "Claude Code, a path through a symbolic link, kept as given",
      claudeGet,
      "/tmp/ss-link/bin/saveslot",
    ],
    ["Claude Code, a path with a space, unquoted", claudeGet, "/tmp/ss sample/bin/saveslot"],
    ["Codex, a path through a symbolic link, kept as given", codexGet, "/tmp/ss-link/bin/saveslot"],
    ["Codex, a path with a space, unquoted", codexGet, "/tmp/ss sample/bin/saveslot"],
  ])("real host output: %s", (_, shown, path) => {
    // The output plus an empty stderr, as hostEntry hands it over.
    expect(entryHolds(`${shown(path)}\n`, path)).toBe(true);
    expect(entryHolds(`${shown(path)}\n`, "/usr/local/bin/saveslot")).toBe(false);
    expect(entryHolds(`${shown(`${path}-old`)}\n`, path)).toBe(false);
  });
  it("an empty path holds nowhere; an OSC escape around the path is taken out", () => {
    expect(entryHolds("anything", "")).toBe(false);
    const bel = String.fromCodePoint(0x07);
    expect(entryHolds(`${ESC}]8;;file://${P}${bel}${P}${ESC}]8;;${bel}`, P)).toBe(true);
  });
});
