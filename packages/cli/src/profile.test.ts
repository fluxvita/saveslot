// Server profiles in the CLI (06-cli §2 «profile», §3.2 «服务器模式») against a stand-in server on
// loopback HTTP: `profile list` / `use`, a command run with a server profile's sign-in (renewed once
// on a refused token), `SAVESLOT_TOKEN` sent to the profile's server, and `connect --profile`: a
// host signing in itself, or a static token for `http`.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProfile, CLOUD_SERVER, writeProfileCredentials } from "@fluxvita/saveslot-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import { TEXTS } from "./texts.ts";

const tok = (prefix: string, c: string) => `${prefix}_${c.repeat(43)}`;
const ACCESS = tok("sls", "a");
const RENEWED = tok("sls", "n");
const ISSUED_TOKEN = tok("slt", "i");
const CONNECTION = tok("slt", "c");

const root = mkdtempSync(join(tmpdir(), "saveslot-profile-cli-"));
let home = "";
const entry = join(root, "bin", "saveslot");
const hostDir = join(root, "hosts");
const argsFile = join(root, "host-args");
let server: Server;
let origin = "";
const seen: { method: string; url: string; auth: string; body: unknown }[] = [];
/** Answers by route; a 401 for a token in `refused`. */
const refused = new Set<string>();
/** Run as a refused token arrives, before the 401 is sent. */
let onRefused: (() => Promise<void>) | undefined;
/** Answers the token endpoint instead of a new pair. */
let tokenAnswer: ((res: ServerResponse) => void) | undefined;

const json = (res: ServerResponse, status: number, v: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(v));
};

beforeAll(async () => {
  mkdirSync(join(root, "bin"));
  mkdirSync(hostDir);
  writeFileSync(entry, "#!/bin/sh\n", { mode: 0o755 });
  // A host that writes its arguments down (one per NUL) and succeeds.
  writeFileSync(join(hostDir, "claude"), `#!/bin/sh\nprintf '%s\\0' "$@" > "${argsFile}"\n`, {
    mode: 0o755,
  });
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const auth = String(req.headers["authorization"] ?? "");
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth,
        body: text === "" ? undefined : req.url === "/oauth/token" ? text : JSON.parse(text),
      });
      if (req.url === "/oauth/token") {
        if (tokenAnswer !== undefined) return tokenAnswer(res);
        return json(res, 200, {
          access_token: RENEWED,
          refresh_token: tok("slr", "s"),
          expires_in: 900,
        });
      }
      if (refused.has(auth.slice(7))) {
        const answer = () =>
          json(res, 401, {
            error: { code: "unauthenticated", message: "m", reason: "expired" },
          });
        if (onRefused !== undefined) return void onRefused().then(answer);
        return answer();
      }
      if (req.method === "GET" && req.url?.startsWith("/v1/slots")) {
        return json(res, 200, {
          level: "list",
          total: 1,
          slots: [
            {
              slot: "ledger",
              slot_id: "sl_8VEZWJ3J7BMKMXTV",
              sv: 1,
              timezone: "Asia/Shanghai",
              tables: [{ table: "ledger.expenses", kind: "base", description: "expenses" }],
            },
          ],
        });
      }
      if (req.method === "POST" && req.url === "/v1/connections") {
        return json(res, 200, {
          id: "ci_01JF0000000000000000000000",
          name: "connector",
          scopes: ["saveslot.read", "saveslot.write"],
          slots: [{ slot: "ledger", slot_id: "sl_01JF0000000000000000000001" }],
          via: "token",
          created_at: "2026-11-21T10:00:00Z",
          token: ISSUED_TOKEN,
        });
      }
      json(res, 404, { error: { code: "not_found", message: "no route", reason: "route" } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});
beforeEach(async () => {
  home = mkdtempSync(join(root, "home-"));
  seen.length = 0;
  refused.clear();
  onRefused = undefined;
  tokenAnswer = undefined;
  await addProfile(home, "lab", origin);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const signIn = (o: { profile?: string; at?: string; access?: string; due?: boolean } = {}) =>
  writeProfileCredentials(home, o.profile ?? "lab", {
    server: o.at ?? origin,
    access_token: o.access ?? ACCESS,
    // Due: within the refresh margin, so a command renews it before its request.
    access_expires_at: new Date(Date.now() + (o.due === true ? 1_000 : 10 * 60_000)).toISOString(),
    refresh_token: tok("slr", "r"),
  });

/** An address nothing listens on. */
async function deadOrigin(): Promise<string> {
  const dead = createServer();
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
  const at = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
  await new Promise((r) => dead.close(r));
  return at;
}

async function cli(argv: string[], o: { env?: Record<string, string>; json?: boolean } = {}) {
  let out = "";
  let err = "";
  const code = await run(
    ["--home", home, ...argv, ...(o.json === true ? ["--json"] : [])],
    { PATH: hostDir, ...o.env },
    {
      out: (s) => {
        out += s;
        return Promise.resolve(true);
      },
      err: (s) => {
        err += s;
      },
      stdoutIsTTY: false,
      stderrIsTTY: false,
      entry,
    },
  );
  return { code, out, err };
}

describe("profile list and use", () => {
  it("local and cloud built in, a registered one; the one in use marked; use switches", async () => {
    const before = await cli(["profile", "list"], { json: true });
    expect(before.code).toBe(0);
    expect(JSON.parse(before.out)).toEqual({
      current: "local",
      profiles: [
        { name: "local", at: join(home, "run", "saveslot.sock") },
        { name: "cloud", at: CLOUD_SERVER },
        { name: "lab", at: origin },
      ],
    });
    expect((await cli(["profile", "use", "lab"])).code).toBe(0);
    const after = await cli(["profile", "list"]);
    expect(after.out).toContain(`* lab  ${origin}  (${TEXTS.profileInUse})`);
    expect(after.out).toContain(`  cloud  ${CLOUD_SERVER}\n`);
  });

  it("use: an unknown profile 6; no name 2", async () => {
    const r = await cli(["profile", "use", "nowhere"]);
    expect([r.code, r.err]).toEqual([6, `${TEXTS.credential("unknown_profile")}\n`]);
    expect((await cli(["profile", "use"])).code).toBe(2);
  });

  it("a name not of the form: 2, the same from use as from --profile, nothing written", async () => {
    for (const name of ["Cloud", "__proto__", "../x", "a".repeat(33)]) {
      const use = await cli(["profile", "use", name]);
      const given = await cli(["slot", "list", "--profile", name]);
      expect([name, use.code, use.err, given.code, given.err]).toEqual([
        name,
        2,
        `${TEXTS.usageError(TEXTS.profileBad)}\n`,
        2,
        `${TEXTS.usageError(TEXTS.profileBad)}\n`,
      ]);
    }
    expect(JSON.parse(readFileSync(join(home, "profiles.json"), "utf8")).current).toBe("local");
    expect(seen).toEqual([]);
  });
});

describe("a command run with a server profile", () => {
  it("--profile lab: to the server, with its sign-in; nothing at the socket", async () => {
    await signIn();
    const r = await cli(["slot", "list", "--profile", "lab"]);
    expect([r.code, r.err]).toEqual([0, ""]);
    expect(seen.map((x) => `${x.method} ${x.url.split("?")[0]} ${x.auth}`)).toEqual([
      `GET /v1/slots Bearer ${ACCESS}`,
    ]);
  });

  it("the profile in use, without --profile", async () => {
    await signIn();
    await cli(["profile", "use", "lab"]);
    expect((await cli(["slot", "list"])).code).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("the token refused: renewed once, the request sent again with the new one", async () => {
    await signIn();
    refused.add(ACCESS);
    const r = await cli(["slot", "list", "--profile", "lab"]);
    expect(r.code).toBe(0);
    expect(seen.map((x) => `${x.method} ${x.url.split("?")[0]} ${x.auth.slice(7)}`)).toEqual([
      `GET /v1/slots ${ACCESS}`,
      "POST /oauth/token ",
      `GET /v1/slots ${RENEWED}`,
    ]);
  });

  it("signed in to another server while a refused request was out: not sent again, 6", async () => {
    // Another server, where profile lab is moved, and signed in, while the first request is out.
    const other: string[] = [];
    const b = createServer((req, res) => {
      other.push(`${req.method} ${req.url} ${req.headers["authorization"] ?? ""}`);
      json(res, 200, { level: "list", total: 0, slots: [] });
    });
    await new Promise<void>((r) => b.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${(b.address() as AddressInfo).port}`;
    try {
      await signIn();
      refused.add(ACCESS);
      onRefused = async () => {
        await addProfile(home, "lab", at);
        await signIn({ at, access: tok("sls", "b") });
      };
      const r = await cli(["slot", "list", "--profile", "lab"]);
      expect([r.code, r.err]).toEqual([6, `${TEXTS.credential("signed_out")}\n`]);
      // The first server got only its own token; the other none at all.
      expect(seen.map((x) => `${x.method} ${x.url.split("?")[0]} ${x.auth}`)).toEqual([
        `GET /v1/slots Bearer ${ACCESS}`,
      ]);
      expect(other).toEqual([]);
    } finally {
      b.closeAllConnections();
      await new Promise((r) => b.close(r));
    }
  });

  it("not signed in: 6, and nothing sent", async () => {
    const r = await cli(["slot", "list", "--profile", "lab"]);
    expect([r.code, r.err]).toEqual([6, `${TEXTS.credential("signed_out")}\n`]);
    expect(seen).toEqual([]);
  });

  it("SAVESLOT_TOKEN: sent to the profile's server", async () => {
    const r = await cli(["slot", "list", "--profile", "lab"], {
      env: { SAVESLOT_TOKEN: CONNECTION },
    });
    expect(r.code).toBe(0);
    expect(seen.map((x) => x.auth)).toEqual([`Bearer ${CONNECTION}`]);
  });

  it("the server not reachable: 7, said of the server", async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    await new Promise((r) => dead.close(r));
    await addProfile(home, "gone", at);
    const r = await cli(["slot", "list", "--profile", "gone"], {
      env: { SAVESLOT_TOKEN: CONNECTION },
    });
    expect([r.code, r.err]).toEqual([7, `${TEXTS.transport("unreachable", true)}\n`]);
  });

  it("the renewal's server not reachable, without SAVESLOT_TOKEN: 7, said of the server", async () => {
    const at = await deadOrigin();
    await addProfile(home, "gone", at);
    await signIn({ profile: "gone", at, due: true });
    const r = await cli(["slot", "list", "--profile", "gone"]);
    expect([r.code, r.err]).toEqual([7, `${TEXTS.transport("unreachable", true)}\n`]);
  });

  it.each([429, 502, 503, 504])(
    "the renewal answered %i: busy, 7, said of the server, as login says it",
    async (status) => {
      await signIn({ due: true });
      tokenAnswer = (res) =>
        json(res, status, { error: { code: "unavailable", message: "m", reason: "busy" } });
      const r = await cli(["slot", "list", "--profile", "lab"]);
      expect([r.code, r.err]).toEqual([7, `${TEXTS.busy(true)}\n`]);
      expect(seen.map((x) => x.url)).toEqual(["/oauth/token"]);
    },
  );

  it("the renewal refused with temporarily_unavailable: busy, 7, said of the server", async () => {
    await signIn({ due: true });
    tokenAnswer = (res) => json(res, 400, { error: "temporarily_unavailable" });
    const r = await cli(["slot", "list", "--profile", "lab"]);
    expect([r.code, r.err]).toEqual([7, `${TEXTS.busy(true)}\n`]);
    expect(seen.map((x) => x.url)).toEqual(["/oauth/token"]);
  });

  it("the renewal answered 500 with no OAuth answer: 1, an answer saveslot cannot read", async () => {
    await signIn({ due: true });
    tokenAnswer = (res) => json(res, 500, { error: { code: "internal", message: "m" } });
    const r = await cli(["slot", "list", "--profile", "lab"]);
    expect([r.code, r.err]).toEqual([1, `${TEXTS.transport("bad_answer", true)}\n`]);
  });

  it("the renewal refused with invalid_client: 6, said of the server", async () => {
    await signIn({ due: true });
    tokenAnswer = (res) => json(res, 400, { error: "invalid_client" });
    const r = await cli(["slot", "list", "--profile", "lab"]);
    expect([r.code, r.err]).toEqual([6, `${TEXTS.renewRefused}\n`]);
    expect(seen.map((x) => x.url)).toEqual(["/oauth/token"]);
  });
});

describe("connect --profile", () => {
  it("claude-code: the remote add command, no token, nothing issued", async () => {
    const r = await cli(["connect", "claude-code", "--profile", "lab"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(TEXTS.remoteSignsIn);
    expect(r.out).toContain(
      `  claude mcp add saveslot --scope user --transport http ${origin}/mcp\n`,
    );
    expect(r.out).not.toMatch(/sl[st]_/);
    expect(seen).toEqual([]);
  });

  it("--apply: the host's command run by its path, no token in it", async () => {
    const r = await cli(["connect", "claude-code", "--profile", "lab", "--apply"]);
    expect(r.code).toBe(0);
    expect(readFileSync(argsFile, "utf8").split("\0").slice(0, -1)).toEqual([
      "mcp",
      "add",
      "saveslot",
      "--scope",
      "user",
      "--transport",
      "http",
      `${origin}/mcp`,
    ]);
    expect(r.out).toContain(`${join(hostDir, "claude")} mcp add saveslot`);
  });

  it("--json: host, server, url and the command; applied with --apply; none for cursor", async () => {
    const add = ["claude", "mcp", "add", "saveslot", "--scope", "user", "--transport", "http"];
    const shown = await cli(["connect", "claude-code", "--profile", "lab"], { json: true });
    expect(JSON.parse(shown.out)).toEqual({
      host: "claude-code",
      server: origin,
      url: `${origin}/mcp`,
      command: [...add, `${origin}/mcp`],
    });
    const applied = await cli(["connect", "claude-code", "--profile", "lab", "--apply"], {
      json: true,
    });
    expect(JSON.parse(applied.out)).toEqual({
      host: "claude-code",
      server: origin,
      url: `${origin}/mcp`,
      command: [...add, `${origin}/mcp`],
      applied: true,
    });
    const cursor = await cli(["connect", "cursor", "--profile", "lab"], { json: true });
    expect(JSON.parse(cursor.out)).toEqual({
      host: "cursor",
      server: origin,
      url: `${origin}/mcp`,
    });
  });

  it("cursor: a static token from connect http, and the entry with its header (06 §3.2)", async () => {
    const c = await cli(["connect", "cursor", "--profile", "lab"]);
    expect(c.code).toBe(0);
    // Cursor cannot sign in to a server in this version: nothing says it does.
    expect(c.out).not.toContain(TEXTS.remoteSignsIn);
    expect(c.out).toContain(TEXTS.cursorServerStatic("lab"));
    expect(c.out).toContain("saveslot connect http --profile lab --name <name>");
    expect(c.out).toContain(
      JSON.stringify(
        {
          mcpServers: {
            saveslot: { url: `${origin}/mcp`, headers: { Authorization: "Bearer TOKEN" } },
          },
        },
        null,
        2,
      ),
    );
    expect(c.out).not.toMatch(/sl[st]_/);
    expect(seen).toEqual([]);
  });

  it("claude-desktop: the address for its screen", async () => {
    const d = await cli(["connect", "claude-desktop", "--profile", "lab"]);
    expect(d.out).toContain(TEXTS.remoteAddress("claude-desktop"));
    expect(d.out).toContain(`  ${origin}/mcp\n`);
    expect(seen).toEqual([]);
  });

  it("vscode: its add command with the address printed, never run (--apply is 2)", async () => {
    const r = await cli(["connect", "vscode", "--profile", "lab"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(TEXTS.remoteSignsIn);
    expect(r.out).toContain(
      `  code --add-mcp '${JSON.stringify({ name: "saveslot", type: "http", url: `${origin}/mcp` })}'\n`,
    );
    // It replaces an entry of the same name; no token in it, so nothing about the file's mode.
    expect(r.out).toContain(TEXTS.vscodeReplaces);
    expect(r.out).not.toContain(TEXTS.vscodeFileMode);
    const applied = await cli(["connect", "vscode", "--profile", "lab", "--apply"]);
    expect(applied.code).toBe(2);
    expect(applied.err).toContain(TEXTS.applyNotHere);
    expect(seen).toEqual([]);
  });

  it("a name, scopes or slots for a host signing in itself: 2, nothing sent", async () => {
    for (const extra of [
      ["--name", "a"],
      ["--scope", "+delete"],
      ["--slots", "ledger"],
    ]) {
      const r = await cli(["connect", "codex", "--profile", "lab", ...extra]);
      expect([extra[0], r.code, r.err]).toEqual([
        extra[0],
        2,
        `${TEXTS.usageError(TEXTS.remoteChosenOnPage)}\n`,
      ]);
      // One full stop before the pointer to --help, not two.
      expect(r.err).toContain("connect http --profile <profile>. See saveslot --help.\n");
    }
    expect(seen).toEqual([]);
  });

  it("http: a static token issued on the server, self-checked there, its server said", async () => {
    await signIn();
    const r = await cli([
      "connect",
      "http",
      "--profile",
      "lab",
      "--name",
      "connector",
      "--slots",
      "ledger",
    ]);
    expect(r.code).toBe(0);
    expect(seen.map((x) => `${x.method} ${x.url.split("?")[0]} ${x.auth.slice(7, 11)}`)).toEqual([
      "POST /v1/connections sls_",
      "GET /v1/slots slt_",
    ]);
    expect(seen[0]?.body).toEqual({ name: "connector", slots: ["ledger"] });
    expect(r.out).toContain(`  SAVESLOT_TOKEN=${ISSUED_TOKEN}\n`);
    expect(r.out).toContain(`  ${TEXTS.serverWord} ${origin}\n`);
    expect(r.out).not.toContain(TEXTS.socketWord);
  });
});
