// `profiles.json` (06-cli §2 «profile»): the built-in profiles, registering and using one, the
// strict parse, and the file's privacy.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialError } from "./credentials.ts";
import {
  addProfile,
  CLOUD_SERVER,
  profileServer,
  profilesFile,
  readProfiles,
  useProfile,
} from "./profiles.ts";
import { ClientUsageError } from "./transport.ts";

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saveslot-profiles-"));
  home = join(root, "home");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function refusal(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("not refused");
}

describe("profiles", () => {
  it("without the file: local in use, nothing registered; local and cloud built in", async () => {
    expect(await readProfiles(home)).toEqual({ current: "local", servers: new Map() });
    expect(await profileServer(home, "local")).toBeUndefined();
    expect(await profileServer(home, "cloud")).toBe(CLOUD_SERVER);
    expect(CLOUD_SERVER).toBe("https://api.saveslot.ai");
  });

  it("a server registered under its origin; the profile in use unchanged until used", async () => {
    await addProfile(home, "home-lab", "https://saveslot.home.example/");
    expect(await readProfiles(home)).toEqual({
      current: "local",
      servers: new Map([["home-lab", "https://saveslot.home.example"]]),
    });
    expect(await profileServer(home, "home-lab")).toBe("https://saveslot.home.example");
    await useProfile(home, "home-lab");
    expect((await readProfiles(home)).current).toBe("home-lab");
    await useProfile(home, "cloud");
    expect((await readProfiles(home)).current).toBe("cloud");
    // Home and file private; the file's text as 06-cli §2 writes it.
    expect(readFileSync(profilesFile(home), "utf8")).toBe(
      `${JSON.stringify(
        { format: 1, current: "cloud", servers: { "home-lab": "https://saveslot.home.example" } },
        null,
        2,
      )}\n`,
    );
  });

  it("addProfile refuses the built-in names, a name not of the form, a server no origin", async () => {
    for (const [name, server] of [
      ["local", "https://a.example"],
      ["cloud", "https://a.example"],
      ["Home", "https://a.example"],
      ["-home", "https://a.example"],
      ["a".repeat(33), "https://a.example"],
      ["home", "http://a.example"],
      ["home", "https://a.example/v1"],
    ] as const) {
      expect([name, await refusal(addProfile(home, name, server))]).toEqual([
        name,
        expect.any(ClientUsageError),
      ]);
    }
    expect(await readProfiles(home)).toEqual({ current: "local", servers: new Map() });
  });

  it("useProfile takes local, cloud or a registered name only", async () => {
    const e = await refusal(useProfile(home, "nowhere"));
    expect(e).toBeInstanceOf(CredentialError);
    expect(e).toMatchObject({ code: "unknown_profile" });
    expect(await refusal(profileServer(home, "nowhere"))).toMatchObject({
      code: "unknown_profile",
    });
    await useProfile(home, "local");
    expect((await readProfiles(home)).current).toBe("local");
  });

  it("a file not of the form: malformed, whatever is wrong in it", async () => {
    await addProfile(home, "lab", "https://lab.example");
    const good = JSON.parse(readFileSync(profilesFile(home), "utf8"));
    for (const [what, v] of [
      ["another key", { ...good, extra: 1 }],
      ["no servers", { format: 1, current: "local" }],
      ["format 2", { ...good, format: 2 }],
      ["current unknown", { ...good, current: "nowhere" }],
      ["a built-in name registered", { ...good, servers: { cloud: "https://c.example" } }],
      ["a server with a path", { ...good, servers: { lab: "https://lab.example/x" } }],
      ["a server not as its origin", { ...good, servers: { lab: "https://lab.example/" } }],
      ["http off loopback", { ...good, servers: { lab: "http://lab.example" } }],
      ["not an object", [good]],
    ] as const) {
      writeFileSync(profilesFile(home), JSON.stringify(v), { mode: 0o600 });
      expect([what, await refusal(readProfiles(home))]).toEqual([
        what,
        expect.objectContaining({ code: "malformed" }),
      ]);
    }
  });

  it("open to others, or a link: permissions; nothing read", async () => {
    await addProfile(home, "lab", "https://lab.example");
    chmodSync(profilesFile(home), 0o644);
    expect(await refusal(readProfiles(home))).toMatchObject({ code: "permissions" });
    chmodSync(profilesFile(home), 0o600);
    chmodSync(home, 0o755);
    expect(await refusal(readProfiles(home))).toMatchObject({ code: "permissions" });
  });

  it("no file in a home open to others: nothing read, nothing refused; the file there: refused", async () => {
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    expect(await readProfiles(home)).toEqual({ current: "local", servers: new Map() });
    writeFileSync(
      profilesFile(home),
      JSON.stringify({ format: 1, current: "local", servers: {} }),
      {
        mode: 0o600,
      },
    );
    expect(await refusal(readProfiles(home))).toMatchObject({ code: "permissions" });
  });

  it("a temporary file left by a write that died is removed by the next write", async () => {
    await addProfile(home, "lab", "https://lab.example");
    writeFileSync(join(home, ".profiles.json.0123456789abcdef.tmp"), "x", { mode: 0o600 });
    await useProfile(home, "lab");
    expect(readdirSync(home).sort()).toEqual(["profiles.json"]);
  });
});
