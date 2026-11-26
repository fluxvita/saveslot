// `saveslot doctor`'s hosts (06-cli §3 step 7) against stand-in hosts on a PATH of their own: the
// real claude and codex are never run. Shell builtins only in the stand-ins.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { doctorHosts } from "./doctor-hosts.ts";
import { TEXTS } from "./texts.ts";

const root = mkdtempSync(join(tmpdir(), "saveslot-doctor-hosts-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

/** This saveslot: an executable file. */
const entry = join(root, "bin", "saveslot");
mkdirSync(join(root, "bin"));
writeFileSync(entry, "#!/bin/sh\n", { mode: 0o755 });

/** A PATH with `claude` printing `entry` for its look-up (or exiting `code`), and an empty home. */
function hosts(o: { claude?: string | number; codex?: string | number; sleep?: boolean }) {
  const dir = join(root, `p${++n}`);
  mkdirSync(dir);
  const home = join(root, `home${n}`);
  mkdirSync(home);
  for (const [name, v] of Object.entries({ claude: o.claude, codex: o.codex })) {
    if (v === undefined) continue;
    const body =
      typeof v === "number"
        ? `exit ${v}`
        : o.sleep === true
          ? "exec /bin/sleep 30"
          : `printf '%s\\n' 'saveslot:' '  command: ${v} mcp' '  SAVESLOT_TOKEN=slt_secret'; exit 0`;
    writeFileSync(join(dir, name), `#!/bin/sh\n[ "$1 $2" = "mcp get" ] || exit 2\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return { env: { PATH: dir, HOME: home }, home };
}

describe("doctor: the hosts' entries", () => {
  it("an entry showing this saveslot passes; another path is a reminder with the remove command", async () => {
    const h = hosts({ claude: entry, codex: `${entry}-old` });
    const all = await doctorHosts({ env: h.env, entry, userHome: h.home, platform: "darwin" });
    expect(all).toEqual([
      { verdict: "pass", item: "host Claude Code", says: TEXTS.doctorHostOk(entry) },
      {
        verdict: "remind",
        item: "host Codex",
        says: TEXTS.doctorHostPathNotSeen(entry),
        fix: TEXTS.doctorHostFix("codex mcp remove saveslot"),
      },
    ]);
    // What the look-up printed (a token in it) is never in a line.
    expect(JSON.stringify(all)).not.toContain("slt_secret");
  });

  it("no entry: skipped; a host not installed: no line; a look-up that does not end: a reminder", async () => {
    const none = hosts({ claude: 1 });
    expect(await doctorHosts({ env: none.env, entry, userHome: none.home })).toEqual([
      { verdict: "skipped", item: "host Claude Code", says: TEXTS.doctorHostNoEntry },
    ]);
    const hung = hosts({ codex: entry, sleep: true });
    expect(
      await doctorHosts({ env: hung.env, entry, userHome: hung.home, timeoutMs: 300 }),
    ).toEqual([{ verdict: "remind", item: "host Codex", says: TEXTS.doctorHostLookupHung }]);
  });

  it("a host with no look-up command, installed: not checked; this saveslot's path unknown: a reminder", async () => {
    const h = hosts({ claude: entry });
    mkdirSync(join(h.home, ".cursor"));
    const all = await doctorHosts({ env: h.env, entry: undefined, userHome: h.home });
    expect(all).toEqual([
      { verdict: "remind", item: "host Claude Code", says: TEXTS.doctorHostSelfUnknown },
      { verdict: "skipped", item: "host Cursor", says: TEXTS.doctorHostNoLookup },
    ]);
  });
});

/** A session listing `conns`, each with its reads (`self` a self-check, `read` another). */
function session(
  conns: { id: string; name: string; state?: string; reads: ("self" | "read")[] }[],
) {
  return async () => ({
    connections: {
      list: async () => ({
        connections: conns.map(({ reads: _, ...c }) => c),
        next_cursor: undefined,
      }),
    },
    readsList: async (q: { connection?: string }) => ({
      reads: (conns.find((c) => c.id === q.connection)?.reads ?? []).map((r) => ({
        at: "2026-11-26T08:00:00Z",
        ...(r === "self" ? { selfcheck: true } : {}),
      })),
    }),
  });
}

describe("doctor: a host not yet read through", () => {
  const unread = (item: string, host: string) => ({
    verdict: "remind",
    item,
    says: TEXTS.doctorHostUnread,
    fix: TEXTS.doctorHostAllow(host),
  });

  it("instances of the host with only their self-check: a reminder with how the host allows the tools", async () => {
    const h = hosts({ claude: entry, codex: entry });
    const all = await doctorHosts({
      env: h.env,
      entry,
      userHome: h.home,
      session: session([
        { id: "c1", name: "laptop · Claude Code", reads: ["self"] },
        { id: "c2", name: "old-name · Claude Code 2", reads: [] },
        { id: "c3", name: "Codex", reads: ["self"] },
      ]) as never,
    });
    expect(all).toEqual([
      { verdict: "pass", item: "host Claude Code", says: TEXTS.doctorHostOk(entry) },
      unread("host Claude Code", "claude-code"),
      { verdict: "pass", item: "host Codex", says: TEXTS.doctorHostOk(entry) },
      unread("host Codex", "codex"),
    ]);
    expect(TEXTS.doctorHostAllow("claude-code")).toContain('--allowedTools "mcp__saveslot"');
    expect(TEXTS.doctorHostAllow("codex")).not.toContain("allowedTools");
  });

  it("no line when one instance was read, when none is the host's, or revoked, or without an entry", async () => {
    const h = hosts({ claude: entry, codex: 1 });
    const all = await doctorHosts({
      env: h.env,
      entry,
      userHome: h.home,
      session: session([
        { id: "c1", name: "laptop · Claude Code", reads: ["self"] },
        { id: "c2", name: "laptop · Claude Code 2", reads: ["read", "self"] },
        { id: "c3", name: "laptop · Codex", reads: [] },
      ]) as never,
    });
    expect(all.filter((f) => f.says === TEXTS.doctorHostUnread)).toEqual([]);
    for (const conns of [
      [{ id: "c1", name: "my agent", reads: [] as ("self" | "read")[] }],
      [
        {
          id: "c1",
          name: "laptop · Claude Code",
          state: "revoked",
          reads: [] as ("self" | "read")[],
        },
      ],
      [],
    ]) {
      const got = await doctorHosts({
        env: h.env,
        entry,
        userHome: h.home,
        session: session(conns) as never,
      });
      expect(got.filter((f) => f.says === TEXTS.doctorHostUnread)).toEqual([]);
    }
  });

  it("the service not answering: no line, no error", async () => {
    const h = hosts({ claude: entry });
    const all = await doctorHosts({
      env: h.env,
      entry,
      userHome: h.home,
      session: async () => {
        throw new Error("connect ENOENT");
      },
    });
    expect(all).toEqual([
      { verdict: "pass", item: "host Claude Code", says: TEXTS.doctorHostOk(entry) },
    ]);
    const unreadable = await doctorHosts({
      env: h.env,
      entry,
      userHome: h.home,
      session: async () =>
        ({
          connections: { list: async () => ({ connections: [{ id: "c1", name: "Claude Code" }] }) },
          readsList: async () => {
            throw new Error("refused");
          },
        }) as never,
    });
    expect(unreadable.filter((f) => f.says === TEXTS.doctorHostUnread)).toEqual([]);
  });
});
