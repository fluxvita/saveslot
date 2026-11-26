// `setup --profile <server profile>` (06-cli §3.3 item 13) against a stand-in server on loopback
// HTTP and stand-in hosts on PATH (no real host is run): signed in first, a slot made on the server,
// the hosts given the remote add command, nothing issued; an entry already there for this server
// or for something else; and what is refused before anything is done.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProfile, writeProfileCredentials } from "@fluxvita/saveslot-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import type { SetupServices } from "./setup.ts";
import { TEXTS } from "./texts.ts";

const tok = (prefix: string, c: string) => `${prefix}_${c.repeat(43)}`;
const ACCESS = tok("sls", "a");
const root = mkdtempSync(join(tmpdir(), "saveslot-setup-server-"));
const hosts = join(root, "hosts");
const entry = join(root, "bin", "saveslot");
let home = "";
let origin = "";
let server: Server;
const seen: string[] = [];
let slots: unknown[] = [];
/** Making a slot breaks the connection instead of answering. */
let draftsBreak = false;

const json = (res: ServerResponse, status: number, v: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));

const services: SetupServices = {
  initialized: async () => {
    throw new Error("a server's setup does not initialize this computer");
  },
  init: async () => {
    throw new Error("not here");
  },
  start: async () => {
    throw new Error("a server's setup starts no service");
  },
  homeProblem: async () => undefined,
  lock: async () => ({ release: async () => {} }),
};

/**
 * A host on PATH: `--version` answers; `mcp get saveslot` prints `<state>/<host>.entry` when it is
 * there (exit 0), else exits 1; `mcp add …` writes its arguments to `<state>/<host>.args` and, unless
 * `<state>/<host>.noentry` is there, an entry holding the URL it was given.
 */
function host(name: string, state: string) {
  writeFileSync(
    join(hosts, name),
    `#!/bin/sh
case "$1" in --version) echo "${name} 9"; exit 0 ;; esac
if [ "$2" = get ]; then [ -f "${state}/${name}.entry" ] && { /bin/cat "${state}/${name}.entry"; exit 0; }; exit 1; fi
if [ "$2" = add ]; then printf '%s\\0' "$@" > "${state}/${name}.args"; [ -f "${state}/${name}.noentry" ] || echo "saveslot: $(eval echo \\$$#) (HTTP)" > "${state}/${name}.entry"; exit 0; fi
exit 2
`,
    { mode: 0o755 },
  );
}

let state = "";
beforeAll(async () => {
  mkdirSync(hosts);
  mkdirSync(join(root, "bin"));
  writeFileSync(entry, "#!/bin/sh\n", { mode: 0o755 });
  server = createServer((req: IncomingMessage, res) => {
    req.resume();
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      seen.push(`${req.method} ${path} ${String(req.headers["authorization"] ?? "").slice(7, 11)}`);
      if (req.method === "GET" && path === "/v1/slots") {
        return json(res, 200, { level: "list", total: slots.length, slots });
      }
      if (req.method === "POST" && path === "/v1/drafts" && draftsBreak) {
        return void res.socket?.destroy();
      }
      if (req.method === "POST" && path === "/v1/drafts") {
        return json(res, 200, {
          outcome: "applied",
          slot: "health",
          slot_id: "sl_8VEZWJ3J7BMKMXTV",
          sv: 1,
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
  state = mkdtempSync(join(root, "state-"));
  host("claude", state);
  host("codex", state);
  seen.length = 0;
  draftsBreak = false;
  slots = [{ slot: "health", slot_id: "sl_8VEZWJ3J7BMKMXTV", sv: 1, timezone: "UTC", tables: [] }];
  await addProfile(home, "lab", origin);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const signIn = (o: { at?: string; profile?: string; due?: boolean } = {}) =>
  writeProfileCredentials(home, o.profile ?? "lab", {
    server: o.at ?? origin,
    access_token: ACCESS,
    // Due: within the refresh margin, so it is renewed before it is used.
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

const args = (h: string) =>
  existsSync(join(state, `${h}.args`))
    ? readFileSync(join(state, `${h}.args`), "utf8")
        .split("\0")
        .slice(0, -1)
    : undefined;

async function setup(
  argv: string[],
  o: {
    env?: Record<string, string>;
    answers?: string[];
    /** Stands in for login's sign-in: its exit code (0: signed in), and its message. */
    signIn?: () => Promise<
      number | { exit: number; message: string; kind?: "declined" | "expired" | "timed_out" }
    >;
    profile?: string;
    services?: SetupServices;
  } = {},
) {
  let out = "";
  let err = "";
  const terminal = o.answers !== undefined;
  const signInCalls: { mode: string | undefined; boundary: unknown }[] = [];
  const code = await run(
    ["--home", home, "setup", "--profile", o.profile ?? "lab", ...argv],
    { PATH: hosts, ...o.env },
    {
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
      stdoutIsTTY: false,
      stderrIsTTY: terminal,
      stdinIsTTY: terminal,
      ...(terminal ? { ask: async () => o.answers?.shift() } : {}),
      entry,
      hostname: "t",
      platform: "darwin",
      watchSignals: () => () => {},
      ...(o.signIn !== undefined
        ? {
            signIn: async (x: { mode?: "browser" | "device"; io: { boundary?: unknown } }) => {
              signInCalls.push({ mode: x.mode, boundary: x.io.boundary });
              const a = await (o.signIn as NonNullable<typeof o.signIn>)();
              const { exit, message, kind } =
                typeof a === "number"
                  ? { exit: a, message: TEXTS.loginRefused, kind: undefined }
                  : a;
              return exit === 0
                ? { ok: true as const, mode: x.mode ?? ("browser" as const) }
                : {
                    ok: false as const,
                    exit,
                    message: message as typeof TEXTS.loginRefused,
                    ...(kind !== undefined ? { kind } : {}),
                  };
            },
          }
        : {}),
    },
    o.services ?? services,
  );
  return { code, out, err, signInCalls };
}

const remote = (url: string) => [
  "mcp",
  "add",
  "saveslot",
  "--scope",
  "user",
  "--transport",
  "http",
  url,
];

describe("setup --profile: signed in, the hosts given the remote add command", () => {
  it("--yes --host claude-code: the command run, nothing issued, no token anywhere", async () => {
    await signIn();
    const r = await setup(["--yes", "--host", "claude-code", "--json"]);
    expect([r.code, JSON.parse(r.out)]).toEqual([
      0,
      { signed_in: "existing", slots: [], hosts: [{ host: "claude-code", state: "done" }] },
    ]);
    expect(args("claude")).toEqual(remote(`${origin}/mcp`));
    expect(seen).toEqual([`GET /v1/slots ${ACCESS.slice(0, 4)}`]);
    expect(`${r.out}${r.err}`).not.toMatch(/sl[str]_/);
    expect(r.signInCalls).toEqual([]);
  });

  it("no slot on the server: made there from the template, with the profile's session", async () => {
    await signIn();
    slots = [];
    const r = await setup(["--yes", "--template", "running", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ slots: [{ template: "running" }], hosts: [] });
    expect(seen).toEqual(["GET /v1/slots sls_", "POST /v1/drafts sls_"]);
  });

  it("an entry for this server already: existing, nothing run", async () => {
    await signIn();
    writeFileSync(join(state, "claude.entry"), `saveslot: ${origin}/mcp (HTTP) - ✓ Connected\n`);
    const r = await setup(["--yes", "--host", "claude-code", "--json"]);
    expect(JSON.parse(r.out).hosts).toEqual([{ host: "claude-code", state: "existing" }]);
    expect(args("claude")).toBeUndefined();
  });

  it("--yes with no --template: no slot, and why, with the templates to give", async () => {
    await signIn();
    slots = [];
    const r = await setup(["--yes", "--host", "claude-code"]);
    expect(r.out).toContain("no slot made: with --yes a slot is made only from --template (");
    expect(r.out).toContain("saveslot slot create <name> --template <template>");
  });

  it("an entry for something else (the local service): left as it is, unconfirmed, how to remove it", async () => {
    await signIn();
    writeFileSync(join(state, "claude.entry"), `saveslot: ${entry} mcp - ✓ Connected\n`);
    const r = await setup(["--yes", "--host", "claude-code"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(TEXTS.unconfirmedOtherEntry);
    expect(r.out).toContain("claude mcp remove saveslot");
    expect(args("claude")).toBeUndefined();
  });

  it("the command done and no entry after: failed, no_entry, 1; nothing to revoke", async () => {
    await signIn();
    writeFileSync(join(state, "claude.noentry"), "");
    const r = await setup(["--yes", "--host", "claude-code", "--json"]);
    expect([r.code, JSON.parse(r.out).hosts]).toEqual([
      1,
      [{ host: "claude-code", state: "failed", reason: "no_entry" }],
    ]);
    expect(seen.some((x) => x.startsWith("DELETE"))).toBe(false);
  });

  it("asked: the commands shown without a token, one answer; the hint to use the profile after", async () => {
    await signIn();
    const r = await setup([], { answers: ["", ""] });
    expect(r.code).toBe(0);
    expect(r.err).toContain(TEXTS.remoteSignsIn);
    expect(r.err).toContain(`--transport http ${origin}/mcp`);
    expect(args("claude")).toEqual(remote(`${origin}/mcp`));
    expect(args("codex")).toEqual(["mcp", "add", "saveslot", "--url", `${origin}/mcp`]);
    expect(r.out).toContain(TEXTS.setupServerAfter("lab"));
  });
});

describe("setup --profile: not signed in", () => {
  it("no one to sign in (--yes): signed_in needed, 8, login not run, nothing sent", async () => {
    const r = await setup(["--yes", "--host", "claude-code", "--json"], { signIn: async () => 0 });
    expect([r.code, JSON.parse(r.out)]).toEqual([8, { signed_in: "needed" }]);
    expect(r.err).toContain(TEXTS.setupSignInFirst("lab"));
    expect([r.signInCalls, seen, args("claude")]).toEqual([[], [], undefined]);
  });

  it("asked: signed in by login (--device passed on), then the rest", async () => {
    const r = await setup(["--device", "--host", "claude-code"], {
      answers: ["", ""],
      signIn: async () => {
        await signIn();
        return 0;
      },
    });
    expect(r.code).toBe(0);
    expect(r.signInCalls.map((c) => c.mode)).toEqual(["device"]);
    expect(args("claude")).toEqual(remote(`${origin}/mcp`));
  });

  it("login is saveslot login's own: it asks the server, and its end is setup's", async () => {
    // No stand-in: this server serves no sign-in, so login ends with its own message and code.
    const r = await setup(["--device", "--host", "claude-code"], { answers: [""] });
    expect(r.code).toBe(1);
    expect(r.err).toContain(TEXTS.loginBadAnswer);
    expect([seen, args("claude")]).toEqual([
      ["GET /.well-known/oauth-authorization-server "],
      undefined,
    ]);
  });

  it("credentials/ open to others: login refuses it before asking the server, its path said", async () => {
    mkdirSync(join(home, "credentials"), { mode: 0o700 });
    chmodSync(join(home, "credentials"), 0o755);
    const r = await setup(["--host", "claude-code", "--json"], { answers: [""] });
    expect([r.code, JSON.parse(r.out), seen, args("claude")]).toEqual([
      6,
      { signed_in: "failed" },
      [],
      undefined,
    ]);
    expect(r.err).toContain(TEXTS.credential("permissions"));
    expect(r.err).toContain(join(home, "credentials"));
  });

  it("login fails: signed_in failed and nothing after it, its message and exit code", async () => {
    const r = await setup(["--host", "claude-code", "--json"], {
      answers: [""],
      signIn: async () => 6,
    });
    expect([r.code, JSON.parse(r.out), seen, args("claude")]).toEqual([
      6,
      { signed_in: "failed" },
      [],
      undefined,
    ]);
    expect(r.err).toContain(TEXTS.loginRefused);
  });

  it("declined on the authorization page (login's kind): signed_in failed, stopped declined, 8", async () => {
    // Told by the kind login gives, not by its words.
    const r = await setup(["--host", "claude-code", "--json"], {
      answers: [""],
      signIn: async () => ({ exit: 8, kind: "declined", message: TEXTS.loginRefused }),
    });
    expect([r.code, JSON.parse(r.out), seen, args("claude")]).toEqual([
      8,
      { signed_in: "failed", stopped: "declined" },
      [],
      undefined,
    ]);
  });

  it.each([
    ["expired", TEXTS.loginExpired],
    ["timed_out", TEXTS.loginTimedOut],
  ] as const)(
    "login ended %s: signed_in failed, not stopped, 8 as login",
    async (kind, message) => {
      const r = await setup(["--host", "claude-code", "--json"], {
        answers: [""],
        signIn: async () => ({ exit: 8, kind, message }),
      });
      expect([r.code, JSON.parse(r.out), seen, args("claude")]).toEqual([
        8,
        { signed_in: "failed" },
        [],
        undefined,
      ]);
      expect(r.err).toContain(message);
    },
  );

  it("a message that reads as a decline but no declined kind: not stopped", async () => {
    // The words alone no longer decide it.
    const r = await setup(["--host", "claude-code", "--json"], {
      answers: [""],
      signIn: async () => ({ exit: 6, message: TEXTS.loginDenied }),
    });
    expect([r.code, JSON.parse(r.out)]).toEqual([6, { signed_in: "failed" }]);
  });

  it("login's untrusted text follows --untrusted-tags, as in saveslot login", async () => {
    const r = await setup(["--host", "claude-code", "--untrusted-tags", "always"], {
      answers: ["", ""],
      signIn: async () => {
        await signIn();
        return 0;
      },
    });
    expect([r.code, r.signInCalls]).toEqual([
      0,
      [{ mode: undefined, boundary: { kind: "tagged" } }],
    ]);
  });

  it("asked, without --device: login chooses its way (no mode given)", async () => {
    const r = await setup(["--host", "claude-code"], {
      answers: ["", ""],
      signIn: async () => {
        await signIn();
        return 0;
      },
    });
    expect([r.code, r.signInCalls.map((c) => c.mode)]).toEqual([0, [undefined]]);
  });

  it("no terminal and no --yes: the plan on stderr (sign in, the command), 8, nothing done", async () => {
    const r = await setup(["--host", "claude-code"], { signIn: async () => 0 });
    expect(r.code).toBe(8);
    expect(r.err).toContain(TEXTS.planSignIn("lab"));
    expect(r.err).toContain(`--transport http ${origin}/mcp`);
    expect([r.signInCalls, seen, args("claude")]).toEqual([[], [], undefined]);
  });
});

describe("setup --profile: the server's failures said as the server's", () => {
  it("--yes, the sign-in's renewal not reachable: 7, said of the server, signed_in failed", async () => {
    const at = await deadOrigin();
    await addProfile(home, "gone", at);
    await signIn({ profile: "gone", at, due: true });
    const r = await setup(["--yes", "--host", "claude-code", "--json"], { profile: "gone" });
    expect([r.code, JSON.parse(r.out)]).toEqual([7, { signed_in: "failed" }]);
    expect(r.err).toContain(TEXTS.transport("unreachable", true));
    expect(args("claude")).toBeUndefined();
  });

  it("the plan, the renewal answered with no OAuth answer: 1, said of the server", async () => {
    await signIn({ due: true });
    const r = await setup(["--host", "claude-code", "--json"]);
    expect([r.code, JSON.parse(r.out)]).toEqual([1, { signed_in: "failed" }]);
    expect(r.err).toContain(TEXTS.transport("bad_answer", true));
    expect(seen).toEqual(["POST /oauth/token "]);
  });

  it("the slot's making broken on the way: 7, said of the server, slot_failed", async () => {
    await signIn();
    slots = [];
    draftsBreak = true;
    const r = await setup(["--yes", "--template", "running", "--json"]);
    expect([r.code, JSON.parse(r.out)]).toEqual([
      7,
      { signed_in: "existing", slots: [], slot_failed: "running", hosts: [] },
    ]);
    expect(r.err).toContain(TEXTS.transport("broken", true));
  });

  it("a home that cannot be used: 1, and no initialized (there is none on this branch)", async () => {
    const r = await setup(["--yes", "--json"], {
      services: { ...services, homeProblem: async () => "the home is in the way" },
    });
    expect([r.code, JSON.parse(r.out)]).toEqual([1, {}]);
  });
});

describe("setup --profile: refused before anything is done", () => {
  it.each([
    [["--yes", "--scope", "+delete"], TEXTS.usageError(TEXTS.setupScopeOnPage), 2],
    [["--yes", "--host", "cursor"], TEXTS.usageError(TEXTS.setupHostBad), 2],
  ])("%j: %s", async (argv, text, code) => {
    await signIn();
    const r = await setup(argv);
    expect([r.code, r.err]).toEqual([code, `${text}\n`]);
    expect(seen).toEqual([]);
  });

  it("SAVESLOT_TOKEN set: 6, as for this computer", async () => {
    const r = await setup(["--yes"], { env: { SAVESLOT_TOKEN: tok("slt", "c") } });
    expect(r.code).toBe(6);
    expect(seen).toEqual([]);
  });

  it("--device without a server profile: 2", async () => {
    let err = "";
    const code = await run(
      ["--home", home, "setup", "--device", "--yes"],
      { PATH: hosts },
      {
        out: () => {},
        err: (s) => {
          err += s;
        },
        stdoutIsTTY: false,
        stderrIsTTY: false,
        platform: "darwin",
      },
      services,
    );
    expect([code, err]).toEqual([2, `${TEXTS.usageError(TEXTS.deviceIsForServer)}\n`]);
  });
});
