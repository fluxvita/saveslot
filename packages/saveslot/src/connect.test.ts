// `saveslot connect`, `connections list` / `revoke`, `reads --connection` and `snippet` against a
// real service (06-cli §3.2, §3.4, §4.8, §4.9). `--apply` runs a stand-in host found on PATH, which
// writes down the arguments it was given.

import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request, TEXTS } from "@fluxvita/saveslot-cli/testing";
import { type CommandIO, serviceCommand, socketFile } from "@fluxvita/saveslot-daemon";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatch } from "./dispatch.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const root = mkdtempSync(join(tmpdir(), "saveslot-connect-"));
const home = join(root, "home");
const hosts = join(root, "hosts");
// A space in it: the host must get it as one argument (no shell between).
const entry = join(root, "my bin", "saveslot");
const argsFile = join(root, "host-args");
const quiet: CommandIO = { out: () => {}, err: () => {} };
const TOKEN = /slt_[A-Za-z0-9_-]{43}/g;

/** Every token any output here showed, or a host was given: none may be left in a file. */
const tokens = new Set<string>();
const keep = (text: string) => {
  for (const t of text.match(TOKEN) ?? []) tokens.add(t);
};

async function saveslot(
  argv: string[],
  o: { env?: Record<string, string>; answers?: string[]; stdinIsTTY?: boolean; home?: string } = {},
) {
  let out = "";
  let err = "";
  const asked: string[] = [];
  const code = await dispatch(
    [...argv, "--home", o.home ?? home],
    { NO_COLOR: "1", PATH: hosts, HOST_ARGS: argsFile, ...o.env },
    {
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
      stdoutIsTTY: true,
      stderrIsTTY: true,
      stdinIsTTY: o.stdinIsTTY ?? o.answers !== undefined,
      ask: async (p) => {
        asked.push(p);
        return o.answers?.shift();
      },
      entry,
    },
  );
  keep(out);
  keep(err);
  return { code, out, err, asked };
}

/** The stand-in host's arguments, as it wrote them down (one per NUL). */
const hostArgs = () => {
  const args = readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
  keep(args.join(" "));
  return args;
};

/** A request with a connection's token: its status. */
const catalogWith = async (token: string) => {
  try {
    await request({ socketPath: socketFile(home), method: "GET", path: "/v1/slots", token });
    return "ok";
  } catch (e) {
    return String((e as { code?: string }).code);
  }
};

beforeAll(async () => {
  mkdirSync(hosts);
  mkdirSync(join(root, "my bin"));
  writeFileSync(entry, "#!/bin/sh\n", { mode: 0o755 });
  // A host: writes its arguments down, and to both its pipes (none of it may come out of the
  // CLI), then exits with HOST_EXIT (0 when not set).
  const host = `#!/bin/sh\nprintf '%s\\0' "$@" > "$HOST_ARGS"\necho "$@"\necho "$@" >&2\nexit "\${HOST_EXIT:-0}"\n`;
  for (const name of ["claude", "codex"]) writeFileSync(join(hosts, name), host, { mode: 0o755 });
  expect(await serviceCommand("init", ["--home", home], quiet)).toBe(0);
  expect(await serviceCommand("start", ["--home", home], quiet)).toBe(0);
  expect((await saveslot(["slot", "create", "health", "--template", "running"])).code).toBe(0);
});
afterAll(async () => {
  await serviceCommand("stop", ["--home", home], quiet);
  rmSync(root, { recursive: true, force: true });
});

describe("connect, then the host reads, then reads shows it", () => {
  let token = "";
  let id = "";

  it("connect claude-code: issued, self-checked, the token once on stdout and nowhere else", async () => {
    const r = await saveslot(["connect", "claude-code", "--name", "MacBook · Claude Code"]);
    expect(r.code).toBe(0);
    const tokens = r.out.match(TOKEN) ?? [];
    expect(tokens).toHaveLength(1);
    token = tokens[0] as string;
    id = /\((ci_[0-9A-Z]{26})\)/.exec(r.out)?.[1] as string;
    expect(r.out).toContain(`${TEXTS.selfcheckPassed} 1 ${TEXTS.selfcheckSlots}`);
    expect(r.out).toContain(
      `claude mcp add saveslot --scope user -e SAVESLOT_TOKEN=${token} -- '${entry}' mcp`,
    );
    expect(r.err).toBe(`${TEXTS.tokenOnce}\n`);
    expect(await catalogWith(token)).toBe("ok");
  });

  it("reads --connection by name and by ID: the self-check marked, the token's own read not", async () => {
    // The self-check, and the read the case above made with the token.
    for (const which of ["MacBook · Claude Code", id]) {
      const r = await saveslot(["reads", "--connection", which]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("2 reads");
      expect(r.out.match(/self-check \(saveslot connect\)/g)).toHaveLength(1);
    }
    expect((await saveslot(["reads", "--connection", "nobody"])).code).toBe(4);
  });

  it("connections list: name, ID, scopes, all slots, when issued", async () => {
    const r = await saveslot(["connections", "list"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      new RegExp(
        `「MacBook · Claude Code」  ${id}  saveslot.read saveslot.write saveslot.schema  ${TEXTS.allSlots}  ${TEXTS.issuedAt} 20`,
      ),
    );
    expect(r.out).not.toMatch(TOKEN);
  });

  it("the same name again: refused, nothing issued", async () => {
    const r = await saveslot(["connect", "codex", "--name", "MacBook · Claude Code"]);
    expect(r.code).toBe(5);
    expect(r.err).toContain("duplicate_name");
    expect(`${r.out}${r.err}`).not.toMatch(TOKEN);
  });

  it("revoke by name, asked and answered y: the token refused from then on", async () => {
    const r = await saveslot(["connections", "revoke", "MacBook · Claude Code"], {
      answers: ["y"],
    });
    expect(r.code).toBe(0);
    expect(r.asked).toEqual([
      `${TEXTS.revokeAsk} 「MacBook · Claude Code」 (${id}) · ${TEXTS.scopeWord} saveslot.read saveslot.write saveslot.schema? [y/N] `,
    ]);
    expect(r.out).toContain(TEXTS.revokedNow);
    expect(await catalogWith(token)).not.toBe("ok");
    const again = await saveslot(["connections", "revoke", id, "--yes"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain(TEXTS.alreadyRevoked);
    const list = await saveslot(["connections", "list"]);
    expect(list.out).toContain(`${TEXTS.revokedAt} 20`);
  });
});

describe("connect --apply: the host's own command, run without a shell", () => {
  it("claude-code: the host gets exactly the arguments 06 §3.2 writes; the token not shown; 0", async () => {
    const r = await saveslot(["connect", "claude-code", "--name", "apply · claude", "--apply"]);
    expect(r.code).toBe(0);
    // The token is the host's now: not on the terminal (06 §8.2), and it works.
    expect(r.out).not.toMatch(TOKEN);
    const token = (hostArgs()[6] ?? "").slice("SAVESLOT_TOKEN=".length);
    expect(token).toMatch(new RegExp(`^${TOKEN.source}$`));
    expect(await catalogWith(token)).toBe("ok");
    expect(hostArgs()).toEqual([
      "mcp",
      "add",
      "saveslot",
      "--scope",
      "user",
      "-e",
      `SAVESLOT_TOKEN=${token}`,
      "--",
      entry,
      "mcp",
    ]);
    expect(r.out).toContain(TEXTS.appliedTo("claude-code"));
    expect(r.out).toContain(
      `  ${hosts}/claude mcp add saveslot --scope user -e ${TEXTS.tokenArg} -- '${entry}' mcp\n`,
    );
    expect(r.err).toBe("");
  });

  it("codex: likewise", async () => {
    const r = await saveslot(["connect", "codex", "--name", "apply · codex", "--apply"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(TOKEN);
    expect(r.out).toContain(
      `  ${hosts}/codex mcp add saveslot --env ${TEXTS.tokenArg} -- '${entry}' mcp\n`,
    );
    const token = (hostArgs()[4] ?? "").slice("SAVESLOT_TOKEN=".length);
    expect(token).toMatch(new RegExp(`^${TOKEN.source}$`));
    expect(hostArgs()).toEqual([
      "mcp",
      "add",
      "saveslot",
      "--env",
      `SAVESLOT_TOKEN=${token}`,
      "--",
      entry,
      "mcp",
    ]);
  });

  it("the host's command fails: the connection kept, the command printed, its status on stderr, 1", async () => {
    const r = await saveslot(["connect", "codex", "--name", "apply · fails", "--apply"], {
      env: { HOST_EXIT: "3" },
    });
    expect(r.code).toBe(1);
    // Failed: the whole command, the token in it once, for the user to run.
    expect(r.out.match(TOKEN)).toHaveLength(1);
    const token = (r.out.match(TOKEN) ?? [])[0] as string;
    expect(r.out).toContain(TEXTS.applyFailedOut);
    expect(r.out).toContain(
      `  ${hosts}/codex mcp add saveslot --env SAVESLOT_TOKEN=${token} -- '${entry}' mcp\n`,
    );
    expect(r.err).toBe(`${TEXTS.applyExit(3)}\n${TEXTS.applyKept}\n${TEXTS.tokenOnce}\n`);
    expect(await catalogWith(token)).toBe("ok");
  });

  it("the host not on PATH: refused before anything is issued, 1", async () => {
    const before = (await saveslot(["connections", "list", "--json"])).out;
    const r = await saveslot(["connect", "claude-code", "--name", "apply · none", "--apply"], {
      env: { PATH: join(root, "my bin") },
    });
    expect(r.code).toBe(1);
    expect(r.err).toBe(`${TEXTS.applyNotFound}\n`);
    expect(r.out).toBe("");
    expect((await saveslot(["connections", "list", "--json"])).out).toBe(before);
  });
});

describe("connections revoke: what it takes", () => {
  it("not found: 4; no terminal and no --yes: 8, nothing revoked; answered n: 8", async () => {
    expect((await saveslot(["connections", "revoke", "nobody", "--yes"])).code).toBe(4);
    const r = await saveslot(["connect", "http", "--name", "to keep"]);
    const token = (r.out.match(TOKEN) ?? [])[0] as string;
    const noTty = await saveslot(["connections", "revoke", "to keep"], { stdinIsTTY: false });
    expect(noTty.code).toBe(8);
    expect(noTty.err).toBe(`${TEXTS.revokeNoTerminal}\n`);
    const no = await saveslot(["connections", "revoke", "to keep"], { answers: ["n"] });
    expect(no.code).toBe(8);
    expect(await catalogWith(token)).toBe("ok");
    const yes = await saveslot(["connections", "revoke", "to keep", "--yes"]);
    expect(yes.code).toBe(0);
    expect(yes.asked).toEqual([]);
    expect(await catalogWith(token)).not.toBe("ok");
  });
});

describe("snippet: no service asked", () => {
  it("for a host: where it goes, then the text; --lang zh-CN; without a host: the text and the table", async () => {
    // A home with no service: snippet asks none.
    let out = "";
    const cc = await dispatch(
      ["snippet", "claude-code", "--home", join(root, "none")],
      {},
      {
        out: (x) => {
          out += x;
        },
        err: () => {},
        stdoutIsTTY: false,
        stderrIsTTY: false,
      },
    );
    expect(cc).toBe(0);
    expect(
      out.startsWith(`${TEXTS.snippetPlace.get("claude-code")?.before}\n\n## saveslot\n`),
    ).toBe(true);
    expect(out).toContain("saveslot_write");
    const zh = await saveslot(["snippet", "codex", "--lang", "zh-CN"]);
    expect(zh.out).toContain("我的长期记录");
    const all = await saveslot(["snippet"]);
    expect(all.out).toContain(TEXTS.snippetPlaces);
    for (const p of TEXTS.snippetPlace.values()) expect(all.out).toContain(p.row);
    // Each host by itself, Gemini CLI and Antigravity CLI each with its own place.
    expect([...TEXTS.snippetPlace.keys()]).toEqual(
      expect.arrayContaining(["gemini", "antigravity"]),
    );
    for (const [host, p] of TEXTS.snippetPlace) {
      const r = await saveslot(["snippet", host]);
      expect(r.code, host).toBe(0);
      expect(r.out.startsWith(`${p.before}\n\n## saveslot\n`), host).toBe(true);
    }
    expect((await saveslot(["snippet", "generic"])).code).toBe(2);
    expect((await saveslot(["snippet", "--lang", "fr"])).code).toBe(2);
  });
});

describe("the self-check refused by the real service's relay", () => {
  // A second home whose socket relays to the real service, refusing the new token's catalog.
  const relayHome = join(root, "relay-home");
  let relay: Server;
  let refusedToken = "";

  beforeAll(async () => {
    mkdirSync(join(relayHome, "run"), { recursive: true, mode: 0o700 });
    mkdirSync(join(relayHome, "credentials"), { recursive: true, mode: 0o700 });
    chmodSync(relayHome, 0o700);
    copyFileSync(join(home, "credentials", "session"), join(relayHome, "credentials", "session"));
    chmodSync(join(relayHome, "credentials", "session"), 0o600);
    relay = createServer((req, res) => {
      const auth = String(req.headers["authorization"] ?? "");
      if (req.method === "GET" && req.url?.startsWith("/v1/slots") && auth.includes("slt_")) {
        refusedToken = auth.slice("Bearer ".length);
        tokens.add(refusedToken);
        req.resume();
        res
          .writeHead(401, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { code: "unauthenticated", message: "refused here" } }));
        return;
      }
      const up = httpRequest(
        { socketPath: socketFile(home), method: req.method, path: req.url, headers: req.headers },
        (r) => {
          res.writeHead(r.statusCode ?? 500, r.headers);
          r.pipe(res);
        },
      );
      up.on("error", () => res.destroy());
      req.pipe(up);
    });
    await new Promise<void>((r) => relay.listen(join(relayHome, "run", "saveslot.sock"), r));
  });
  afterAll(async () => {
    relay.closeAllConnections();
    await new Promise((r) => relay.close(r));
  });

  it("revoked in the real service, its token refused there, never shown; 1", async () => {
    const r = await saveslot(["connect", "claude-code", "--name", "refused · relay"], {
      home: relayHome,
    });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(`${r.out}${r.err}`).not.toMatch(TOKEN);
    expect(r.err).toContain(TEXTS.selfcheckRevoked);
    expect(refusedToken).toMatch(new RegExp(`^${TOKEN.source}$`));
    expect(await catalogWith(refusedToken)).toBe("unauthenticated");
    const list = JSON.parse((await saveslot(["connections", "list", "--json"])).out) as {
      connections: { name: string; state?: string }[];
    };
    expect(list.connections.find((c) => c.name === "refused · relay")?.state).toBe("revoked");
  });
});

describe("the saveslot executable", () => {
  const bin = fileURLToPath(new URL("./bin.ts", import.meta.url));

  /** Runs it with `args`; `closeStdout` destroys the reading end of its stdout at once. */
  function runBin(file: string, args: string[], o: { closeStdout?: boolean; node?: boolean } = {}) {
    const child = spawn(
      o.node === false ? file : process.execPath,
      o.node === false ? args : ["--conditions=source", file, ...args],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env["PATH"] ?? "", NO_COLOR: "1" },
      },
    );
    if (o.closeStdout === true) child.stdout.destroy();
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    return new Promise<{ code: number | null; out: string; err: string }>((resolve) =>
      child.on("close", (code) => {
        keep(out);
        keep(err);
        resolve({ code, out, err });
      }),
    );
  }

  it("stdout closed (EPIPE): no crash, no stack; the instance revoked; 1", async () => {
    const r = await runBin(bin, ["connect", "http", "--name", "epipe", "--home", home], {
      closeStdout: true,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain(TEXTS.outputLost);
    expect(r.err).toContain(TEXTS.outputLostRevoked);
    expect(r.err).not.toMatch(/\n\s+at /);
    expect(r.err).not.toMatch(TOKEN);
    const list = JSON.parse((await saveslot(["connections", "list", "--json"])).out) as {
      connections: { name: string; state?: string }[];
    };
    expect(list.connections.find((c) => c.name === "epipe")?.state).toBe("revoked");
  });

  it("started by a symbolic link: the command holds the link, as started, not what it points to", async () => {
    const real = join(root, "real", "saveslot");
    const link = join(root, "links", "saveslot");
    mkdirSync(join(root, "real"));
    mkdirSync(join(root, "links"));
    writeFileSync(
      real,
      `#!/usr/bin/env -S node --conditions=source\nimport(${JSON.stringify(new URL("./bin.ts", import.meta.url).href)});\n`,
      { mode: 0o755 },
    );
    symlinkSync(real, link);
    const r = await runBin(link, ["connect", "claude-code", "--name", "linked", "--home", home], {
      node: false,
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain(` -- ${link} mcp\n`);
    expect(r.out).not.toContain(real);
  });
});

describe("afterwards", () => {
  it("no file under the home holds any token shown or given (nor a 12-character piece of one)", () => {
    expect(tokens.size).toBeGreaterThan(5);
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        const st = statSync(p, { throwIfNoEntry: false });
        if (st?.isDirectory()) walk(p);
        else if (st?.isFile()) files.push(p);
      }
    };
    walk(home);
    expect(files.some((f) => f.endsWith("saveslot.log"))).toBe(true);
    const holding = files.filter((f) => {
      const text = readFileSync(f).toString("latin1");
      return [...tokens].some((t) => text.includes(t.slice(4, 16)));
    });
    expect(holding).toEqual([]);
  });
});
