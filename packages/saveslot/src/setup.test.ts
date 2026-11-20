// `saveslot setup` against a real service (06-cli §3.3). The hosts are stand-ins on PATH: they
// answer `--version`, look their entry up (`mcp get saveslot`) in a file of their own, and add it
// (`mcp add …`), writing down what they were given; ADD_MODE (or ADD_MODE_<host>, for one host)
// makes the add fail in each way. Most cases run the command in this process (`dispatch`); one runs
// the `saveslot` executable itself.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, TEXTS } from "@fluxvita/saveslot-cli/testing";
import { type CommandIO, serviceCommand, setupLock, socketFile } from "@fluxvita/saveslot-daemon";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatch } from "./dispatch.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const root = mkdtempSync(join(tmpdir(), "saveslot-setup-"));
const hosts = join(root, "hosts");
const entry = join(root, "bin", "saveslot");
const quiet: CommandIO = { out: () => {}, err: () => {} };
/** Permission bits do not stop root: those cases cannot fail for it, and are skipped. */
const AS_ROOT = process.getuid?.() === 0;
const TOKEN = /slt_[A-Za-z0-9_-]{43}/g;
const homes: string[] = [];
/** The homes made by the case running now: their services are stopped when it ends. */
let caseHomes: string[] = [];
/** Every token a stand-in host was given: none may be left in a file under any home. */
const tokens = new Set<string>();

/** A stand-in host. Its entry is the file <name>.entry beside it; each add is logged in "calls". */
const HOST = `#!/bin/sh
# Shell builtins only: PATH here holds the stand-in hosts and nothing else.
me="\${0##*/}"
reg="$HOST_DIR/$me.entry"
mode="$ADD_MODE"
case "$me" in
  claude) [ -n "$ADD_MODE_claude" ] && mode="$ADD_MODE_claude" ;;
  codex) [ -n "$ADD_MODE_codex" ] && mode="$ADD_MODE_codex" ;;
esac
if [ "$1" = --version ] && [ "$mode" = hangversion ]; then echo $$ > "$HOST_DIR/versioning"; exec /bin/sleep 30; fi
case "$1" in
  --version) echo "$me 9.9.9 (stand-in)"; exit 0 ;;
esac
if [ "$1 $2" = "mcp get" ]; then
  # The marker is empty for a moment before the PID is in it, as \`echo $$ >\` leaves it: held
  # open here, so that a reader that does not wait for the PID fails every time.
  if [ "$mode" = hangget ]; then : > "$HOST_DIR/getting"; /bin/sleep 0.5; echo $$ > "$HOST_DIR/getting"; exec /bin/sleep 30; fi
  # The look-up after the add hangs (the add wrote the entry): marked for a signal to be sent.
  if [ "$mode" = hangafter ] && [ -f "$reg" ]; then echo $$ > "$HOST_DIR/looking"; exec /bin/sleep 30; fi
  # Gone between the look-up and the add.
  if [ "$mode" = vanish ] && [ ! -f "$reg" ]; then /bin/rm "$0"; exit 1; fi
  # The add that follows runs a file the system cannot execute (0644: EACCES on Linux and macOS).
  if [ "$mode" = noexec ] && [ ! -f "$reg" ]; then /bin/chmod 644 "$0"; fi
  if [ -f "$reg" ]; then while IFS= read -r l; do printf '%s\\n' "$l"; done < "$reg"; exit 0; fi
  exit 1
fi
if [ "$1 $2" = "mcp add" ]; then
  printf '%s\\n' "$me" >> "$HOST_DIR/calls"
  echo "$@"; echo "$@" >&2
  case "$mode" in
    exit3) exit 3 ;;
    sleep) echo $$ > "$HOST_DIR/adding"; exec /bin/sleep 30 ;;
    noentry) exit 0 ;;
    otherpath) printf '%s\\n' /elsewhere/saveslot > "$reg"; exit 0 ;;
    oldpath) printf '%s-old\\n' "$@" > "$reg"; exit 0 ;;
    vanish) exit 0 ;;
  esac
  printf '%s\\n' "$@" > "$reg"
  exit 0
fi
exit 9
`;

function freshHosts() {
  // What the last hosts were given: kept for the check of the homes' files at the end.
  for (const n of ["claude", "codex"]) {
    const f = join(hosts, `${n}.entry`);
    if (existsSync(f)) for (const t of readFileSync(f, "utf8").match(TOKEN) ?? []) tokens.add(t);
  }
  rmSync(hosts, { recursive: true, force: true });
  mkdirSync(hosts, { recursive: true });
  for (const n of ["claude", "codex"]) writeFileSync(join(hosts, n), HOST, { mode: 0o755 });
}

/**
 * A home of its own. Its service is stopped when the case that made it ends, so services do not
 * pile up through the file; one made at a describe's top (`shared`, used by its cases in turn) is
 * stopped by that describe's afterAll.
 */
function newHome(o: { shared?: boolean } = {}): string {
  const h = join(root, `home-${homes.length}`);
  homes.push(h);
  if (o.shared !== true) caseHomes.push(h);
  return h;
}

/** A home as `saveslot init` leaves it, made once (beforeAll) and never used itself. */
const template = join(root, "template");

/** Every entry under `dir` with its mode: "<path from dir> <d|f> <mode>". */
function entries(dir: string, from = dir): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      const s = statSync(p);
      const line = `${p.slice(from.length + 1)} ${s.isDirectory() ? "d" : "f"} ${(s.mode & 0o777).toString(8)}`;
      return s.isDirectory() ? [line, ...entries(p, from)] : [line];
    });
}

/**
 * A home of its own that is initialized already: a copy of the template, with each entry's mode
 * set back as init made it (a copy makes its directories with the default mode). For the cases
 * whose subject is not how a home is made: making one costs over a second, a copy a tenth of one.
 * The cases about a new home, about init's own result, and those that run the executable make
 * theirs with `newHome`, and setup initializes it.
 */
function initializedHome(): string {
  const h = newHome();
  cpSync(template, h, { recursive: true });
  chmodSync(h, statSync(template).mode & 0o777);
  for (const line of entries(template)) {
    const [path, , mode] = line.split(" ") as [string, string, string];
    chmodSync(join(h, path), Number.parseInt(mode, 8));
  }
  return h;
}

/** Every file under `dir` by its bytes, with every entry's mode. */
function digest(dir: string): string {
  const h = createHash("sha256");
  for (const line of entries(dir)) {
    h.update(`${line}\n`);
    const [path, kind] = line.split(" ") as [string, string];
    if (kind === "f") h.update(readFileSync(join(dir, path)));
  }
  return h.digest("hex");
}
/** The template as init left it (beforeAll): no case may change it. */
let templateDigest = "";

const stopService = (h: string) =>
  serviceCommand("stop", ["--home", h], quiet).then(
    () => {},
    () => {},
  );

async function setup(
  home: string,
  args: string[],
  o: {
    answers?: string[];
    terminal?: boolean;
    env?: Record<string, string>;
    platform?: NodeJS.Platform;
    hostTimeoutMs?: number;
    probeTimeoutMs?: number;
    stderrIsTTY?: boolean;
    hostname?: string;
    signals?: (on: (signal: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT") => void) => () => void;
  } = {},
) {
  let out = "";
  let err = "";
  const asked: string[] = [];
  const code = await dispatch(
    ["setup", ...args, "--home", home],
    { NO_COLOR: "1", PATH: hosts, HOST_DIR: hosts, HOME: join(root, "user-home"), ...o.env },
    {
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
      stdoutIsTTY: true,
      stderrIsTTY: o.stderrIsTTY ?? true,
      stdinIsTTY: o.terminal ?? o.answers !== undefined,
      ask: async (p) => {
        asked.push(p);
        return o.answers?.shift();
      },
      entry,
      hostname: o.hostname ?? "testhost",
      platform: o.platform ?? "darwin",
      ...(o.hostTimeoutMs !== undefined ? { hostTimeoutMs: o.hostTimeoutMs } : {}),
      ...(o.probeTimeoutMs !== undefined ? { probeTimeoutMs: o.probeTimeoutMs } : {}),
      // No signal reaches this process from a case unless the case sends one.
      watchSignals: o.signals ?? (() => () => {}),
    },
  );
  return { code, out, err, asked };
}

async function connections(home: string) {
  let out = "";
  await dispatch(
    ["connections", "list", "--json", "--home", home],
    {},
    {
      out: (s) => {
        out += s;
      },
      err: () => {},
      stdoutIsTTY: false,
      stderrIsTTY: false,
    },
  );
  return (
    JSON.parse(out) as {
      connections: { id: string; name: string; state?: string; scopes: string[] }[];
    }
  ).connections;
}

/** The token a stand-in host was given, from its entry. */
const tokenOf = (host: string) =>
  (readFileSync(join(hosts, `${host}.entry`), "utf8").match(TOKEN) ?? [])[0] as string;

/** The hosts whose add ran, in order. */
const calls = () =>
  existsSync(join(hosts, "calls"))
    ? readFileSync(join(hosts, "calls"), "utf8").trim().split("\n")
    : [];

const works = async (home: string, token: string) => {
  try {
    await request({ socketPath: socketFile(home), method: "GET", path: "/v1/slots", token });
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "user-home"));
  writeFileSync(entry, "#!/bin/sh\n", { mode: 0o755 });
  // The product's own init, and nothing after it: no service was started on the template.
  expect(await serviceCommand("init", ["--home", template], quiet)).toBe(0);
  templateDigest = digest(template);
});
afterEach(async () => {
  const made = caseHomes;
  caseHomes = [];
  for (const h of made) await stopService(h);
});
afterAll(async () => {
  // Each was stopped already; this is for a case cut short before its afterEach.
  for (const h of homes) await stopService(h);
  rmSync(root, { recursive: true, force: true });
});

describe("an initialized home: a copy of the template", () => {
  it("has init's entries, modes and bytes; a mode that differs is seen, and setup refuses the home", async () => {
    const home = initializedHome();
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(entries(home)).toEqual(entries(template));
    expect(digest(home)).toBe(templateDigest);
    // As a plain copy leaves it (directories of the default mode), it is not what init made.
    const copied = newHome();
    cpSync(template, copied, { recursive: true });
    chmodSync(copied, 0o700);
    chmodSync(join(copied, "control"), 0o755);
    expect(digest(copied)).not.toBe(templateDigest);
    const r = await setup(copied, ["--yes", "--json"], { terminal: false });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`chmod 700 ${join(copied, "control")}`);
  });

  it("two of them are two homes: what setup does in one is not in the other, nor in the template", async () => {
    freshHosts();
    const a = initializedHome();
    const b = initializedHome();
    expect((await setup(a, ["--yes", "--host", "codex"], { terminal: false })).code).toBe(0);
    expect((await setup(b, ["--yes"], { terminal: false })).code).toBe(0);
    expect((await connections(a)).map((c) => c.name)).toEqual(["testhost · Codex"]);
    expect(await connections(b)).toEqual([]);
    // The token of a's instance is no credential of b's service.
    expect(await works(a, tokenOf("codex"))).toBe(true);
    expect(await works(b, tokenOf("codex"))).toBe(false);
    expect(digest(template)).toBe(templateDigest);
  });
});

describe("setup on a terminal, from nothing", () => {
  const home = newHome({ shared: true });
  afterAll(() => stopService(home));

  it("init, start, a slot, both hosts: asked, then done; no token shown", async () => {
    freshHosts();
    const r = await setup(home, [], { answers: ["", "", ""] });
    expect(r.code).toBe(0);
    expect(r.asked).toEqual([TEXTS.chooseNumbers, TEXTS.chooseNumbers, TEXTS.runThese(2)]);
    // Before the answer, the commands with <token>: by the path found, nothing issued yet.
    expect(r.err).toContain(
      `  ${hosts}/claude mcp add saveslot --scope user -e ${TEXTS.tokenArg} -- ${entry} mcp`,
    );
    expect(r.err).toContain(
      `  ${hosts}/codex mcp add saveslot --env ${TEXTS.tokenArg} -- ${entry} mcp`,
    );
    expect(`${r.out}${r.err}`).not.toMatch(TOKEN);
    expect(r.out).toContain("Claude Code: added · 「testhost · Claude Code」");
    expect(r.out).toContain("Codex: added · 「testhost · Codex」");
    // What the user agreed to: the default scopes, all three of them, before anything is issued.
    expect(r.err).toContain("(scope saveslot.read saveslot.write saveslot.schema)");
    // The default instance can create slots: no hint of how to let it.
    expect(r.out).not.toContain("cannot create a slot");
    const list = await connections(home);
    expect(list.map((c) => c.name).sort()).toEqual(["testhost · Claude Code", "testhost · Codex"]);
    for (const h of ["claude", "codex"]) expect(await works(home, tokenOf(h))).toBe(true);
    expect(readFileSync(join(hosts, "claude.entry"), "utf8")).toContain(entry);
  });

  it("run again: each step there already; nothing issued, nothing asked to run", async () => {
    const before = await connections(home);
    const r = await setup(home, [], { answers: [""] });
    expect(r.code).toBe(0);
    expect(r.out).toContain(TEXTS.stepInitialized);
    expect(r.out).toContain(TEXTS.stepSlotsThere);
    expect(r.out).toContain("Claude Code: added already");
    expect(r.out).toContain("Codex: added already");
    expect(r.asked).toEqual([TEXTS.chooseNumbers]);
    expect(await connections(home)).toEqual(before);
    // The hosts' look-up output holds their tokens: read, never shown.
    expect(readFileSync(join(hosts, "codex.entry"), "utf8")).toMatch(TOKEN);
    expect(`${r.out}${r.err}`).not.toMatch(TOKEN);
  });

  it("an entry whose instance is revoked: not confirmed, said how to replace it; still 0", async () => {
    const codex = (await connections(home)).find((c) => c.name === "testhost · Codex");
    await dispatch(
      ["connections", "revoke", codex?.id as string, "--yes", "--home", home],
      {},
      {
        out: () => {},
        err: () => {},
        stdoutIsTTY: false,
        stderrIsTTY: false,
      },
    );
    const r = await setup(home, ["--yes", "--host", "codex"], { terminal: false });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Codex: ${TEXTS.hostState("unconfirmed")}`);
    expect(r.out).toContain("codex mcp remove saveslot");
  });

  it("an older instance of the name, no host entry: a numbered name, the old one named", async () => {
    rmSync(join(hosts, "codex.entry"));
    const r = await setup(home, ["--yes", "--host", "codex"], { terminal: false });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Codex: added · 「testhost · Codex 2」");
    expect((await connections(home)).map((c) => c.name)).toContain("testhost · Codex 2");
  });
});

describe("setup: an instance of the name, active, and no entry in the host", () => {
  it("issued under a numbered name; the older one named in the summary, not revoked", async () => {
    freshHosts();
    const home = initializedHome();
    expect((await setup(home, ["--yes"], { terminal: false })).code).toBe(0);
    let out = "";
    await dispatch(
      ["connect", "http", "--name", "testhost · Codex", "--home", home],
      {},
      {
        out: (x) => {
          out += x;
        },
        err: () => {},
        stdoutIsTTY: false,
        stderrIsTTY: false,
        entry,
      },
    );
    const older = /ci_[0-9A-Z]{26}/.exec(out)?.[0] as string;
    const r = await setup(home, ["--yes", "--host", "codex"], { terminal: false });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Codex: added · 「testhost · Codex 2」");
    expect(r.out).toContain(TEXTS.staleInstance);
    expect(r.out).toContain(older);
    expect((await connections(home)).find((c) => c.id === older)?.state).toBeUndefined();
  });
});

describe("setup without a terminal", () => {
  it("no --yes: what it would do on stderr, <token> in the commands; nothing done, 8", async () => {
    freshHosts();
    const home = newHome();
    const r = await setup(home, ["--template", "running", "--host", "claude-code"], {
      terminal: false,
    });
    expect(r.code).toBe(8);
    expect(r.err).toContain(TEXTS.setupWouldDo);
    expect(r.err).toContain(`-e ${TEXTS.tokenArg} -- ${entry} mcp`);
    expect(r.err).toContain(TEXTS.setupNoTerminal);
    expect(r.out).toBe("");
    expect(existsSync(join(home, "control"))).toBe(false);
  });

  it("--yes with --host and no --template: no slot made, that host only", async () => {
    freshHosts();
    const home = initializedHome();
    const r = await setup(home, ["--yes", "--host", "codex"], { terminal: false });
    expect(r.code).toBe(0);
    expect(r.out).toContain(TEXTS.stepNoSlot);
    expect((await connections(home)).map((c) => c.name)).toEqual(["testhost · Codex"]);
    expect(existsSync(join(hosts, "claude.entry"))).toBe(false);
  });

  it("--scope -schema: the instance cannot create slots, and the summary says how to let it", async () => {
    freshHosts();
    const home = initializedHome();
    const r = await setup(home, ["--yes", "--host", "codex", "--scope", "-schema"], {
      terminal: false,
    });
    expect(r.code).toBe(0);
    expect((await connections(home)).map((c) => c.scopes)).toEqual([
      ["saveslot.read", "saveslot.write"],
    ]);
    expect(r.out).toContain(TEXTS.noSchemaHint(true));
  });

  it("--scope -schema and no host: nothing issued, so no hint", async () => {
    freshHosts();
    const home = initializedHome();
    const r = await setup(home, ["--yes", "--scope", "-schema"], { terminal: false });
    expect(r.code).toBe(0);
    expect(await connections(home)).toEqual([]);
    expect(r.out).not.toContain("cannot create a slot");
  });

  it("--json: one value, each host and its instance, no token", async () => {
    freshHosts();
    const home = initializedHome();
    const r = await setup(
      home,
      ["--yes", "--host", "claude-code", "--template", "budget", "--json"],
      {
        terminal: false,
      },
    );
    expect(r.code).toBe(0);
    const v = JSON.parse(r.out) as { hosts: { host: string; state: string }[]; slots: unknown[] };
    expect(v.hosts.map((h) => [h.host, h.state])).toEqual([["claude-code", "done"]]);
    expect(v.slots).toEqual([{ template: "budget", slot: "plan" }]);
    expect(r.out).not.toMatch(TOKEN);
  });
});

describe("setup: asked and declined, refused, or busy", () => {
  it("declined: nothing issued, no host changed, 8", async () => {
    freshHosts();
    const home = newHome();
    const r = await setup(home, ["--template", "running"], { answers: ["", "n"] });
    expect(r.code).toBe(8);
    expect(r.err).toContain(TEXTS.setupDeclined);
    expect(await connections(home)).toEqual([]);
    expect(existsSync(join(hosts, "claude.entry"))).toBe(false);
  });

  it.each([
    ["on Windows", [], { platform: "win32" as const }, 2],
    ["--host for a host without a command", ["--host", "cursor"], {}, 2],
    ["with SAVESLOT_TOKEN set", [], { env: { SAVESLOT_TOKEN: `slt_${"a".repeat(43)}` } }, 6],
  ])("%s: refused before anything is done", async (_, args, o, exit) => {
    const home = newHome();
    const r = await setup(home, args as string[], { ...o, terminal: false });
    expect(r.code).toBe(exit);
    expect(existsSync(join(home, "control"))).toBe(false);
  });

  it("another setup running on the home: nothing done, 7", async () => {
    const home = newHome();
    const held = await setupLock(home);
    try {
      const r = await setup(home, ["--yes"], { terminal: false });
      expect(r.code).toBe(7);
      expect(r.err).toContain(TEXTS.setupBusy);
      expect(existsSync(join(home, "control"))).toBe(false);
    } finally {
      await held?.release();
    }
  });
});

describe("setup: the host's command fails; the instance revoked (no one has its token)", () => {
  it.each([
    ["exits 3", "exit3", TEXTS.applyExit(3)],
    ["does not finish in time", "sleep", TEXTS.applyTimeout],
    ["is a file the system cannot execute", "noexec", TEXTS.applyCannotRun],
  ])("it %s: failed, revoked, no token anywhere; 1", async (_, mode, why) => {
    freshHosts();
    const home = initializedHome();
    const r = await setup(home, ["--yes", "--host", "codex"], {
      terminal: false,
      env: { ADD_MODE: mode },
      // A short limit only where it is what is tested; the others get the 60 s default, so a
      // slow start cannot turn their failure into a timeout.
      ...(mode === "sleep" ? { hostTimeoutMs: 1_000 } : {}),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Codex: failed · 「testhost · Codex」");
    expect(r.out).toContain(why);
    expect(r.out).toContain(TEXTS.setupRevoked);
    expect(`${r.out}${r.err}`).not.toMatch(TOKEN);
    expect((await connections(home)).map((c) => c.state)).toEqual(["revoked"]);
  });

  it("ran, and its look-up shows an entry without this path as written: added, with a note", async () => {
    // No entry before, the command done, an entry after: added. Hosts write paths their own ways.
    freshHosts();
    const home = initializedHome();
    const r = await setup(home, ["--yes", "--host", "codex", "--json"], {
      terminal: false,
      env: { ADD_MODE: "otherpath" },
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hosts).toMatchObject([
      { host: "codex", state: "done", connection: { state: "live" } },
    ]);
    const text = await setup(newHome(), ["--yes", "--host", "claude-code"], {
      terminal: false,
      env: { ADD_MODE: "otherpath" },
    });
    expect(text.out).toContain(TEXTS.pathNotSeenAfter);
  });

  it("ran, but its look-up does not show the entry: failed, the instance kept", async () => {
    freshHosts();
    const home = initializedHome();
    const r = await setup(home, ["--yes", "--host", "codex"], {
      terminal: false,
      env: { ADD_MODE: "noentry" },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain(TEXTS.entryNotSeen);
    expect((await connections(home)).map((c) => c.state)).toEqual([undefined]);
  });
});

describe("setup: the defects the review found", () => {
  it("--host given twice (and --template): once each; one instance, one add", async () => {
    freshHosts();
    const home = initializedHome();
    const r = await setup(
      home,
      [
        "--yes",
        "--host",
        "codex",
        "--host",
        "codex",
        "--template",
        "budget",
        "--template",
        "budget",
      ],
      { terminal: false, env: {} },
    );
    expect(r.code).toBe(0);
    expect(calls()).toEqual(["codex"]);
    expect((await connections(home)).map((c) => c.name)).toEqual(["testhost · Codex"]);
    expect(r.out.match(/made from the template/g)).toHaveLength(1);
  });

  it("an entry and more than one live instance of its name: none picked, each listed with its reads", async () => {
    freshHosts();
    const home = initializedHome();
    expect((await setup(home, ["--yes", "--host", "codex"], { terminal: false })).code).toBe(0);
    // The entry removed, twice re-added: three live instances; the host holds the third's token.
    for (let k = 0; k < 2; k++) {
      rmSync(join(hosts, "codex.entry"));
      expect((await setup(home, ["--yes", "--host", "codex"], { terminal: false })).code).toBe(0);
    }
    const live = (await connections(home)).filter((c) => c.state === undefined);
    expect(live.map((c) => c.name)).toEqual([
      "testhost · Codex",
      "testhost · Codex 2",
      "testhost · Codex 3",
    ]);
    const r = await setup(home, ["--yes", "--host", "codex", "--json"], { terminal: false });
    expect(r.code).toBe(0);
    const v = JSON.parse(r.out) as { hosts: Record<string, unknown>[] };
    expect(v.hosts[0]).not.toHaveProperty("connection");
    expect(v.hosts[0]).toMatchObject({
      host: "codex",
      state: "existing",
      connections: live.map((c) => ({ id: c.id, name: c.name, last_read: null })),
    });
    const text = await setup(home, ["--yes", "--host", "codex"], { terminal: false });
    expect(text.out).toContain(TEXTS.existingSeveral);
    for (const c of live) expect(text.out).toContain(c.id);
  });

  it("stdin a terminal and stderr not: nothing asked, nothing done, 8", async () => {
    freshHosts();
    const home = newHome();
    const r = await setup(home, ["--host", "codex"], { answers: ["", ""], stderrIsTTY: false });
    expect(r.code).toBe(8);
    expect(r.asked).toEqual([]);
    expect(r.err).toContain(TEXTS.setupNoTerminalErr);
    expect(existsSync(join(home, "control"))).toBe(false);
    expect(calls()).toEqual([]);
  });
});

describe("setup: --json, and a host failing on the way", () => {
  it("two hosts, the first's command fails: it is revoked and said; the second is added; 1", async () => {
    freshHosts();
    const home = newHome();
    const r = await setup(home, ["--yes", "--host", "claude-code", "--host", "codex", "--json"], {
      terminal: false,
      env: { ADD_MODE_claude: "exit3" },
    });
    expect(r.code).toBe(1);
    expect(calls()).toEqual(["claude", "codex"]);
    const v = JSON.parse(r.out) as Record<string, unknown> & {
      hosts: { host: string; state: string; reason?: string; connection?: { state: string } }[];
    };
    expect(v).toMatchObject({ initialized: "done", service: "ready", slots: [] });
    expect(v.hosts).toMatchObject([
      {
        host: "claude-code",
        state: "failed",
        reason: "command_failed",
        connection: { state: "revoked" },
      },
      { host: "codex", state: "done", connection: { state: "live" } },
    ]);
    // The host command's status on stderr, in --json too.
    expect(r.err).toContain(`Claude Code: ${TEXTS.applyExit(3)}`);
    expect(`${r.out}${r.err}`).not.toMatch(TOKEN);
  });

  it("the service does not start: the same object, service failed, nothing after it", async () => {
    freshHosts();
    const home = initializedHome();
    expect((await setup(home, ["--yes"], { terminal: false })).code).toBe(0);
    await serviceCommand("stop", ["--home", home], quiet);
    writeFileSync(join(home, "config.toml"), "nonsense = 1\n");
    const r = await setup(home, ["--yes", "--host", "codex", "--json"], { terminal: false });
    expect(r.code).toBe(5);
    expect(JSON.parse(r.out)).toEqual({
      initialized: "existing",
      service: "failed",
      stopped: undefined,
    });
  });
});

describe("setup: an entry there, and what it holds", () => {
  it("run again with the entry not showing this path (another, or saveslot-old): not confirmed, 0", async () => {
    for (const mode of ["otherpath", "oldpath"]) {
      freshHosts();
      const home = initializedHome();
      const first = await setup(home, ["--yes", "--host", "codex"], {
        terminal: false,
        env: { ADD_MODE: mode },
      });
      expect(first.code).toBe(0);
      const r = await setup(home, ["--yes", "--host", "codex", "--json"], { terminal: false });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out).hosts).toEqual([
        { host: "codex", state: "unconfirmed", reason: "path_not_seen" },
      ]);
      // Not told to remove it outright: it may well work.
      const text = await setup(home, ["--yes", "--host", "codex"], { terminal: false });
      expect(text.out).toContain(TEXTS.unconfirmedPathNotSeen);
    }
  });

  it("ran, the look-up shows no entry: what to run to undo it, the instance's ID in it", async () => {
    freshHosts();
    const home = initializedHome();
    const r = await setup(home, ["--yes", "--host", "claude-code"], {
      terminal: false,
      env: { ADD_MODE: "noentry" },
    });
    expect(r.code).toBe(1);
    const id = (await connections(home))[0]?.id as string;
    expect(r.out).toContain("claude mcp remove saveslot --scope user");
    expect(r.out).toContain(`saveslot connections revoke ${id}`);
  });

  it("the look-up after the add does not end: failed (lookup_failed), the instance kept", async () => {
    freshHosts();
    const home = initializedHome();
    const r = await setup(home, ["--yes", "--host", "codex", "--json"], {
      terminal: false,
      // What is tested is the limit: 3 s, time for --version however slow; the look-up hangs 30 s.
      env: { ADD_MODE: "hangafter" },
      probeTimeoutMs: 3_000,
    });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).hosts).toMatchObject([
      { host: "codex", state: "failed", reason: "lookup_failed", connection: { state: "live" } },
    ]);
  });

  it("the look-up does not end: failed (lookup_failed), nothing issued", async () => {
    freshHosts();
    const home = initializedHome();
    const r = await setup(home, ["--yes", "--host", "codex", "--json"], {
      terminal: false,
      // The default limit (5 s): time for --version to answer however slow the machine; the
      // look-up hangs for 30 s, so it ends at the limit either way.
      env: { ADD_MODE: "hangget" },
    });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).hosts).toEqual([
      { host: "codex", state: "failed", reason: "lookup_failed" },
    ]);
    expect(await connections(home)).toEqual([]);
  });
});

describe("setup: what it is given, and what it says", () => {
  it("--timezone without --template: a usage error; refused with a template: as slot create says it", async () => {
    const home = newHome();
    expect(
      (await setup(home, ["--yes", "--timezone", "Asia/Tokyo"], { terminal: false })).code,
    ).toBe(2);
    expect(existsSync(join(home, "control"))).toBe(false);
    freshHosts();
    const r = await setup(home, ["--yes", "--template", "running", "--timezone", "Mars/Olympus"], {
      terminal: false,
    });
    expect(r.code).toBe(5);
    expect(r.err).toContain(TEXTS.timezoneRefused);
  });

  it.each([
    ["a long name", "h".repeat(100), `${"h".repeat(64)} · Codex`],
    ["an emoji across the cut", `${"h".repeat(63)}😀tail`, `${"h".repeat(63)}😀 · Codex`],
    ["none", "", "Codex"],
  ])("the computer's name: %s", async (_, hostname, named) => {
    freshHosts();
    const home = initializedHome();
    expect(
      (await setup(home, ["--yes", "--host", "codex"], { terminal: false, hostname })).code,
    ).toBe(0);
    expect((await connections(home)).map((c) => c.name)).toEqual([named]);
  });

  it("a host without an add command is listed, not numbered", async () => {
    freshHosts();
    const home = initializedHome();
    mkdirSync(join(root, "user-home", ".cursor"), { recursive: true });
    try {
      const r = await setup(home, ["--template", "budget"], { answers: ["", "n"] });
      expect(r.code).toBe(8);
      expect(r.err).toContain(`  - Cursor: ${TEXTS.hostManual("cursor")}`);
      expect(r.err).toMatch(/ {2}1 \[x\] Claude Code/);
      expect(r.err).toMatch(/ {2}2 \[x\] Codex/);
      expect(r.err).not.toMatch(/ {2}3 \[/);
    } finally {
      rmSync(join(root, "user-home", ".cursor"), { recursive: true, force: true });
    }
  });

  it("the input ends at a question: what was done, then 8", async () => {
    freshHosts();
    const home = newHome();
    const r = await setup(home, [], { answers: [""] });
    expect(r.code).toBe(8);
    expect(r.err).toContain(TEXTS.setupInputEnded);
    expect(r.err).toContain(TEXTS.doneSoFar);
    expect(r.err).toContain(TEXTS.doneInitialized);
    expect(r.err).toContain(`${TEXTS.doneSlot} running`);
    // The lock was let go: another setup runs.
    expect((await setup(home, ["--yes"], { terminal: false })).code).toBe(0);
  });

  it("started from npx's cache: the note on stderr", async () => {
    freshHosts();
    const home = initializedHome();
    const npx = join(root, "_npx", "a1", "saveslot");
    mkdirSync(join(root, "_npx", "a1"), { recursive: true });
    writeFileSync(npx, "#!/bin/sh\n", { mode: 0o755 });
    let err = "";
    const code = await dispatch(
      ["setup", "--yes", "--host", "codex", "--home", home],
      { PATH: hosts, HOST_DIR: hosts, HOME: join(root, "user-home") },
      {
        out: () => {},
        err: (s) => {
          err += s;
        },
        stdoutIsTTY: false,
        stderrIsTTY: false,
        entry: npx,
        hostname: "testhost",
        watchSignals: () => () => {},
      },
    );
    expect(code).toBe(0);
    expect(err).toContain(TEXTS.entryMayGo);
  });

  it("init cannot use the home (a directory made 0755 beforehand): the path and the fix, 1", async () => {
    const home = newHome();
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    const r = await setup(home, ["--yes"], { terminal: false });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`chmod 700 ${home}`);
    expect(r.err).not.toContain("bug");
  });
});

describe("setup: asked to stop while a host's command runs", () => {
  /** Runs setup with codex's add hanging; fires `signal` once it runs; what came of it. */
  async function stopped(
    signal: "SIGINT" | "SIGHUP",
    args: string[],
    o: { mode: string; marker: string; probeTimeoutMs?: number; host?: "codex" | "claude" } = {
      mode: "sleep",
      marker: "adding",
    },
  ) {
    freshHosts();
    const home = initializedHome();
    let fire: ((s: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT") => void) | undefined;
    const running = setup(home, ["--yes", "--host", "codex", "--host", "claude-code", ...args], {
      terminal: false,
      env: { [`ADD_MODE_${o.host ?? "codex"}`]: o.mode },
      ...(o.probeTimeoutMs !== undefined ? { probeTimeoutMs: o.probeTimeoutMs } : {}),
      signals: (on) => {
        fire = on;
        return () => {
          fire = undefined;
        };
      },
    });
    const marker = join(hosts, o.marker);
    // The host writes its PID with `echo $$ >`: the file is there, empty, before the PID is in it.
    // Read too early, the PID would be 0, and kill(0, 0) is this process's own group: "alive".
    const pidIn = (): number | undefined => {
      const text = existsSync(marker) ? readFileSync(marker, "utf8") : "";
      return /^[1-9][0-9]*\n$/.test(text) ? Number(text) : undefined;
    };
    let pid = pidIn();
    for (let k = 0; k < 600 && pid === undefined; k++) {
      await new Promise((r) => setTimeout(r, 50));
      pid = pidIn();
    }
    if (pid === undefined) throw new Error(`${o.marker}: no PID written`);
    fire?.(signal);
    const r = await running;
    // SIGKILLed with its group: gone once reaped, which may come a moment after setup returns.
    const gone = () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    for (let k = 0; k < 100 && !gone(); k++) await new Promise((w) => setTimeout(w, 50));
    return { r, home, alive: !gone() };
  }

  it("SIGINT: the host's group killed, the instance revoked, what was done said; 130", async () => {
    const { r, home, alive } = await stopped("SIGINT", []);
    expect(r.code).toBe(130);
    expect(r.err).toContain(TEXTS.setupInterrupted("SIGINT"));
    // The service was started by this run: listed; the host stopped is in the summary, its ID too.
    expect(r.err).toContain(TEXTS.doneService);
    const list = await connections(home);
    expect(list.map((c) => c.state)).toEqual(["revoked"]);
    expect(r.err).toContain(`Codex: failed · 「testhost · Codex」 (${list[0]?.id})`);
    expect(r.err).not.toContain(TEXTS.setupDone);
    expect(calls()).toEqual(["codex"]);
    expect(alive).toBe(false);
  });

  it("SIGHUP (the terminal closed), --json: the host stopped is in hosts, its instance revoked; 129", async () => {
    const { r, home, alive } = await stopped("SIGHUP", ["--json"]);
    expect(r.code).toBe(129);
    const v = JSON.parse(r.out) as { hosts: unknown[]; stopped: string };
    const id = (await connections(home))[0]?.id;
    expect(v.stopped).toBe("interrupted");
    expect(v.hosts).toEqual([
      {
        host: "codex",
        state: "failed",
        reason: "interrupted",
        connection: { id, name: "testhost · Codex", state: "revoked" },
      },
    ]);
    expect(alive).toBe(false);
    expect(`${r.out}${r.err}`).not.toMatch(TOKEN);
  });

  it("SIGINT while the host is looked up after its command succeeded: interrupted, the instance kept, said", async () => {
    const { r, home, alive } = await stopped("SIGINT", [], {
      mode: "hangafter",
      marker: "looking",
    });
    expect(r.code).toBe(130);
    const list = await connections(home);
    expect(list.map((c) => c.state)).toEqual([undefined]);
    expect(r.err).toContain(`Codex: failed · 「testhost · Codex」 (${list[0]?.id})`);
    expect(r.err).toContain(TEXTS.entryNotChecked);
    expect(r.err).toContain(`saveslot connections revoke ${list[0]?.id}`);
    expect(calls()).toEqual(["codex"]);
    expect(alive).toBe(false);
    const json = await stopped("SIGINT", ["--json"], { mode: "hangafter", marker: "looking" });
    expect(JSON.parse(json.r.out).hosts).toMatchObject([
      { host: "codex", state: "failed", reason: "interrupted", connection: { state: "live" } },
    ]);
  });

  it("SIGINT while the first host's --version hangs: no host said to be missing, none in hosts; 130", async () => {
    // claude is probed first; codex, on PATH too, is never probed.
    const { r, alive } = await stopped("SIGINT", ["--json"], {
      mode: "hangversion",
      marker: "versioning",
      host: "claude",
      probeTimeoutMs: 60_000,
    });
    expect(r.code).toBe(130);
    expect(JSON.parse(r.out).hosts).toEqual([]);
    expect(r.err).not.toContain(TEXTS.hostNotFound);
    expect(alive).toBe(false);
  });

  it.each([
    ["its --version", "hangversion", "versioning"],
    ["its look-up before the add", "hangget", "getting"],
  ])(
    "SIGINT while %s hangs: killed at once, not waited for to its limit; 130",
    async (_, mode, marker) => {
      // A limit of a minute, and a host that would answer after 30 s: ended by the signal or not.
      const began = Date.now();
      const { r, home, alive } = await stopped("SIGINT", [], {
        mode,
        marker,
        probeTimeoutMs: 60_000,
      });
      expect(r.code).toBe(130);
      expect(Date.now() - began).toBeLessThan(20_000);
      expect(alive).toBe(false);
      expect(await connections(home)).toEqual([]);
    },
  );
});

describe("setup: its own instances, whatever the computer is called now", () => {
  it("the hostname changed (macOS names it after the network): the entry's instance is still its own", async () => {
    freshHosts();
    const home = initializedHome();
    expect(
      (await setup(home, ["--yes", "--host", "codex"], { terminal: false, hostname: "mac-a" }))
        .code,
    ).toBe(0);
    const r = await setup(home, ["--yes", "--host", "codex", "--json"], {
      terminal: false,
      hostname: "bogon",
    });
    expect(r.code).toBe(0);
    // Named under the old name: may be the host's, not taken to be; nothing issued.
    const v = JSON.parse(r.out).hosts;
    expect(v).toMatchObject([
      {
        host: "codex",
        state: "unconfirmed",
        reason: "instance_unsure",
        connections: [{ name: "mac-a · Codex", last_read: null }],
      },
    ]);
    expect(v[0]).not.toHaveProperty("connection");
    expect(calls()).toEqual(["codex"]);
    const text = await setup(home, ["--yes", "--host", "codex"], {
      terminal: false,
      hostname: "bogon",
    });
    expect(text.code).toBe(0);
    expect(text.out).toContain(TEXTS.unconfirmedInstanceUnsure);
    expect(text.out).toContain("mac-a · Codex");
  });

  /** An instance the user made by hand, named like the host's. */
  async function userInstance(home: string, name: string): Promise<string> {
    let out = "";
    await dispatch(
      ["connect", "http", "--name", name, "--home", home],
      {},
      {
        out: (x) => {
          out += x;
        },
        err: () => {},
        stdoutIsTTY: false,
        stderrIsTTY: false,
        entry,
      },
    );
    return /ci_[0-9A-Z]{26}/.exec(out)?.[0] as string;
  }

  it("setup's own revoked, only the user's left, named like the host's: not taken for the host's", async () => {
    freshHosts();
    const home = initializedHome();
    expect((await setup(home, ["--yes", "--host", "codex"], { terminal: false })).code).toBe(0);
    const own = (await connections(home))[0]?.id as string;
    await dispatch(
      ["connections", "revoke", own, "--yes", "--home", home],
      {},
      { out: () => {}, err: () => {}, stdoutIsTTY: false, stderrIsTTY: false },
    );
    const theirs = await userInstance(home, "anything · Codex");
    const r = await setup(home, ["--yes", "--host", "codex", "--json"], { terminal: false });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hosts).toEqual([
      {
        host: "codex",
        state: "unconfirmed",
        reason: "instance_unsure",
        connections: [{ id: theirs, name: "anything · Codex", last_read: null }],
      },
    ]);
    expect(calls()).toEqual(["codex"]);
  });

  it("setup's own and one named like it: setup's own is the one named", async () => {
    freshHosts();
    const home = initializedHome();
    expect((await setup(home, ["--yes", "--host", "codex"], { terminal: false })).code).toBe(0);
    await userInstance(home, "anything · Codex");
    const r = await setup(home, ["--yes", "--host", "codex", "--json"], { terminal: false });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hosts).toMatchObject([
      { host: "codex", state: "existing", connection: { name: "testhost · Codex", state: "live" } },
    ]);
  });
});

describe("setup: the home as it is, before anything is made in it", () => {
  /** The home `make` gives: refused before anything is made in it, said with `said`. */
  async function refused(make: (base: string) => string, said: string) {
    const base = mkdtempSync(join(root, "odd-"));
    const home = make(base);
    homes.push(home);
    caseHomes.push(home);
    try {
      const r = await setup(home, ["--yes", "--json"], { terminal: false });
      expect(r.code).toBe(1);
      expect(JSON.parse(r.out)).toEqual({ initialized: "failed" });
      expect(r.err).toContain(said);
      expect(r.err).not.toContain("bug");
      expect(existsSync(join(home, "run"))).toBe(false);
    } finally {
      chmodSync(base, 0o700);
    }
  }

  it.skipIf(AS_ROOT).each([
    [
      "its parent cannot be written",
      (base: string) => {
        chmodSync(base, 0o500);
        return join(base, "home");
      },
      "is not a directory this user can write",
    ],
  ])("%s: said, nothing made, {initialized: failed}, 1", async (_, make, said) => {
    await refused(make, said);
  });

  // The mode is read, not tried: the same for root.
  it.each([
    [
      "it is 0500",
      (base: string) => {
        mkdirSync(join(base, "home"), { recursive: true, mode: 0o500 });
        chmodSync(join(base, "home"), 0o500);
        return join(base, "home");
      },
      "its mode is 500",
    ],
    [
      "it is a symbolic link",
      (base: string) => {
        mkdirSync(join(base, "real"), { recursive: true, mode: 0o700 });
        symlinkSync(join(base, "real"), join(base, "home"));
        return join(base, "home");
      },
      "is a symbolic link",
    ],
    [
      "it is 0755 and holds things",
      (base: string) => {
        mkdirSync(join(base, "home"), { recursive: true, mode: 0o755 });
        chmodSync(join(base, "home"), 0o755);
        writeFileSync(join(base, "home", "notes.txt"), "x");
        return join(base, "home");
      },
      "It already holds 1 entry",
    ],
  ])("%s: said, nothing made, {initialized: failed}, 1", async (_, make, said) => {
    await refused(make, said);
  });
});

describe("setup: --json when a step fails, and what was done", () => {
  it("a slot that cannot be made: slot_failed names it", async () => {
    freshHosts();
    const home = newHome();
    const r = await setup(
      home,
      ["--yes", "--template", "running", "--timezone", "Mars/Olympus", "--json"],
      {
        terminal: false,
      },
    );
    expect(r.code).toBe(5);
    expect(JSON.parse(r.out)).toMatchObject({
      initialized: "done",
      service: "ready",
      slots: [],
      slot_failed: "running",
    });
  });

  it("the service running already: done so far does not say it was started", async () => {
    freshHosts();
    const home = initializedHome();
    expect((await setup(home, ["--yes"], { terminal: false })).code).toBe(0);
    rmSync(join(hosts, "codex"));
    rmSync(join(hosts, "claude"));
    const r = await setup(home, [], { answers: [] });
    expect(r.err).toContain(TEXTS.doneSoFar);
    expect(r.err).not.toContain(TEXTS.doneService);
  });
});

describe("the saveslot executable", () => {
  /** The `saveslot` executable from the sources: this package's bin, run by node. */
  const launcherFile = () => {
    const bin = new URL("./bin.ts", import.meta.url).href;
    const launcher = join(root, "bin", "saveslot-real");
    writeFileSync(
      launcher,
      `#!${process.execPath} --conditions=source\nimport(${JSON.stringify(bin)});\n`,
      {
        mode: 0o755,
      },
    );
    return launcher;
  };

  it("setup --yes with two hosts: both added; no token on stdout or stderr", async () => {
    freshHosts();
    const home = newHome();
    const launcher = launcherFile();
    const child = spawn(
      launcher,
      ["setup", "--yes", "--host", "claude-code", "--host", "codex", "--home", home],
      {
        env: { PATH: hosts, HOST_DIR: hosts, HOME: join(root, "user-home") },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    const code = await new Promise<number | null>((r) => child.on("close", r));
    expect({ code, err: err.includes("error") ? err : "" }).toEqual({ code: 0, err: "" });
    expect(out).toContain("Claude Code: added");
    expect(out).toContain("Codex: added");
    expect(`${out}${err}`).not.toMatch(TOKEN);
    expect(readFileSync(join(hosts, "codex.entry"), "utf8")).toContain(launcher);
  });

  it.each([
    ["SIGHUP", 129],
    ["SIGQUIT", 131],
  ] as const)(
    "%s to the process while a host's command runs: it stops cleanly; %i",
    async (signal, exit) => {
      freshHosts();
      const home = newHome();
      const launcher = launcherFile();
      const child = spawn(launcher, ["setup", "--yes", "--host", "codex", "--home", home], {
        env: { PATH: hosts, HOST_DIR: hosts, HOME: join(root, "user-home"), ADD_MODE: "sleep" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let err = "";
      child.stdout.resume();
      child.stderr.on("data", (c: Buffer) => {
        err += c.toString("utf8");
      });
      const closed = new Promise<number | null>((r) => child.on("close", r));
      const marker = join(hosts, "adding");
      for (let k = 0; k < 1200 && !existsSync(marker); k++)
        await new Promise((r) => setTimeout(r, 50));
      child.kill(signal);
      expect(await closed).toBe(exit);
      expect(err).toContain(TEXTS.setupInterrupted(signal));
      expect((await connections(home)).map((c) => c.state)).toEqual(["revoked"]);
    },
  );
});

describe("afterwards", () => {
  it("the template is as init left it: every case had a copy", () => {
    expect(digest(template)).toBe(templateDigest);
  });

  it("no file under any home holds a token any host was given (nor a 12-character piece of one)", () => {
    freshHosts();
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
    for (const h of homes) if (existsSync(h)) walk(h);
    expect(files.some((f) => f.endsWith("saveslot.log"))).toBe(true);
    const holding = files.filter((f) => {
      const text = readFileSync(f).toString("latin1");
      return [...tokens].some((t) => text.includes(t.slice(4, 16)));
    });
    expect(holding).toEqual([]);
  });
});

describe("setup: more of what it is given", () => {
  it("--yes and no --host: no host added, though both are found", async () => {
    freshHosts();
    const home = initializedHome();
    const r = await setup(home, ["--yes", "--json"], { terminal: false });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hosts).toEqual([]);
    expect(calls()).toEqual([]);
  });

  it("--scope and two --template: the instance's scopes; a slot from each", async () => {
    freshHosts();
    const home = initializedHome();
    const r = await setup(
      home,
      [
        "--yes",
        "--host",
        "codex",
        "--scope",
        "+schema",
        "--template",
        "running",
        "--template",
        "budget",
        "--json",
      ],
      { terminal: false },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).slots).toEqual([
      { template: "running", slot: "health" },
      { template: "budget", slot: "plan" },
    ]);
    let out = "";
    await dispatch(
      ["connections", "list", "--json", "--home", home],
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
    expect(JSON.parse(out).connections[0].scopes).toEqual([
      "saveslot.read",
      "saveslot.write",
      "saveslot.schema",
    ]);
  });

  it("the host's file gone between the look-up and the add: failed, revoked", async () => {
    freshHosts();
    const home = initializedHome();
    const r = await setup(home, ["--yes", "--host", "codex", "--json"], {
      terminal: false,
      env: { ADD_MODE: "vanish" },
    });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).hosts).toMatchObject([
      { host: "codex", state: "failed", reason: "cannot_run", connection: { state: "revoked" } },
    ]);
  });

  it("--host for a host not found: not_found, with no reason; 1", async () => {
    freshHosts();
    rmSync(join(hosts, "claude"));
    const home = initializedHome();
    const r = await setup(home, ["--yes", "--host", "claude-code", "--json"], { terminal: false });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).hosts).toEqual([{ host: "claude-code", state: "not_found" }]);
  });

  it("run/ a file in a home otherwise fine: the lock cannot be made; said, {initialized: failed}, 1", async () => {
    const home = newHome();
    mkdirSync(home, { mode: 0o700 });
    chmodSync(home, 0o700);
    writeFileSync(join(home, "run"), "x");
    const r = await setup(home, ["--yes", "--json"], { terminal: false });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({ initialized: "failed" });
    expect(r.err).toContain(`${join(home, "run")} is in the way`);
    expect(r.err).not.toContain(join(home, "run", "setup"));
    expect(r.err).not.toContain("bug");
  });

  it("control/ of mode 0755 in a home otherwise fine: said with its fix; nothing made, run/ not either; 1", async () => {
    const home = newHome();
    mkdirSync(join(home, "control"), { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    chmodSync(join(home, "control"), 0o755);
    const r = await setup(home, ["--yes", "--json"], { terminal: false });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({ initialized: "failed" });
    expect(r.err).toContain(`${join(home, "control")} has mode 755`);
    expect(r.err).toContain(`chmod 700 ${join(home, "control")}`);
    expect(r.err).not.toContain("mkdir ~/.saveslot");
    expect(existsSync(join(home, "run"))).toBe(false);
  });

  it("two setups at once on one home: one runs, the other finds it busy (7); then the lock is free", async () => {
    freshHosts();
    const home = newHome();
    const [a, b] = await Promise.all([
      setup(home, ["--yes"], { terminal: false }),
      setup(home, ["--yes"], { terminal: false }),
    ]);
    expect([a.code, b.code].sort()).toEqual([0, 7]);
    expect((await setup(home, ["--yes"], { terminal: false })).code).toBe(0);
  });
});
