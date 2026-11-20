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
