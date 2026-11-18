// homeProblem (06-cli §3.3 item 8): what makes a home unusable as it is, looked at before anything
// is made in it. Symbolic links above the home are followed (a user directory reached through a
// link is common); the home itself being a link is refused.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { init } from "./commands.ts";
import { homeProblem } from "./setup-support.ts";
import { TEXTS } from "./texts.ts";

const root = mkdtempSync(join(tmpdir(), "saveslot-home-problem-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A fresh directory for one case. */
let n = 0;
const base = () => {
  const d = join(root, `case-${n++}`);
  mkdirSync(d, { mode: 0o700 });
  return d;
};

describe("homeProblem: the directories above a home not made yet", () => {
  it("reached through a symbolic link to a directory: nothing in the way", async () => {
    const b = base();
    mkdirSync(join(b, "real"), { mode: 0o700 });
    symlinkSync(join(b, "real"), join(b, "linked"));
    expect(await homeProblem(join(b, "linked", "home"))).toBeUndefined();
    // Deeper: the nearest existing directory is the link itself.
    expect(await homeProblem(join(b, "linked", "a", "b", "home"))).toBeUndefined();
  });

  it("a link to a file: that link named, and why", async () => {
    const b = base();
    writeFileSync(join(b, "file"), "x");
    symlinkSync(join(b, "file"), join(b, "linked"));
    const said = await homeProblem(join(b, "linked", "home"));
    expect(said).toContain(
      `${join(b, "linked")} is a symbolic link that points to something that is not a directory`,
    );
  });

  it("a link to nothing: that link named, and why", async () => {
    const b = base();
    symlinkSync(join(b, "gone"), join(b, "linked"));
    const said = await homeProblem(join(b, "linked", "home"));
    expect(said).toContain(`${join(b, "linked")} is a symbolic link that points to nothing`);
  });

  it("a file (not a link) above: in the way", async () => {
    const b = base();
    writeFileSync(join(b, "file"), "x");
    expect(await homeProblem(join(b, "file", "home"))).toContain(
      `${join(b, "file")} is in the way`,
    );
  });
});

describe("homeProblem: the home itself", () => {
  it("a symbolic link to a directory of mode 0700: refused, told to give the directory, not to chmod", async () => {
    const b = base();
    mkdirSync(join(b, "real"), { mode: 0o700 });
    symlinkSync(join(b, "real"), join(b, "home"));
    const said = await homeProblem(join(b, "home"));
    expect(said).toContain("is a symbolic link");
    expect(said).toContain("--home");
    expect(said).not.toContain("chmod");
  });

  it("a directory of mode 0700: nothing in the way", async () => {
    const b = base();
    mkdirSync(join(b, "home"), { mode: 0o700 });
    expect(await homeProblem(join(b, "home"))).toBeUndefined();
  });

  it("a file: in the way", async () => {
    const b = base();
    writeFileSync(join(b, "home"), "x");
    expect(await homeProblem(join(b, "home"))).toContain(`${join(b, "home")} is in the way`);
  });

  it("another user's directory: said so", async () => {
    const b = base();
    mkdirSync(join(b, "home"), { mode: 0o700 });
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      expect(await homeProblem(join(b, "home"))).toContain("belongs to another user");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("homeProblem: the directories saveslot keeps in the home", () => {
  it.each([
    [
      "control",
      "a mode of 0755",
      (p: string) => {
        mkdirSync(p, { mode: 0o700 });
        chmodSync(p, 0o755);
      },
      (p: string) => TEXTS.initSubMode(p, "755"),
    ],
    [
      "run",
      "a file",
      (p: string) => writeFileSync(p, "x"),
      (p: string) => TEXTS.initInTheWay(p, "EEXIST"),
    ],
    [
      "credentials",
      "a link",
      (p: string) => {
        mkdirSync(`${p}-real`, { mode: 0o700 });
        symlinkSync(`${p}-real`, p);
      },
      (p: string) => TEXTS.initSubLink(p),
    ],
  ])("%s/ %s: said with its own fix", async (name, _, make, said) => {
    const b = base();
    const home = join(b, "home");
    mkdirSync(home, { mode: 0o700 });
    make(join(home, name));
    expect(await homeProblem(home)).toBe(said(join(home, name)));
  });

  it("all three 0700: nothing in the way", async () => {
    const b = base();
    const home = join(b, "home");
    mkdirSync(home, { mode: 0o700 });
    for (const n of ["control", "credentials", "run"]) mkdirSync(join(home, n), { mode: 0o700 });
    expect(await homeProblem(home)).toBeUndefined();
  });
});

describe("saveslot init on a home it cannot use as it is", () => {
  it("a directory made 0755 beforehand: the path and the fix, 1; nothing made in it", async () => {
    const b = base();
    const home = join(b, "home");
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    const err: string[] = [];
    const code = await init(home, { rotate: false }, { out: () => {}, err: (l) => err.push(l) });
    expect(code).toBe(1);
    expect(err).toEqual([TEXTS.initHomeMode(home, "755", 0)]);
    expect(readdirSync(home)).toEqual([]);
  });

  it("a symbolic link to a directory of mode 0700: refused before anything is made there, 1", async () => {
    const b = base();
    mkdirSync(join(b, "real"), { mode: 0o700 });
    symlinkSync(join(b, "real"), join(b, "home"));
    const err: string[] = [];
    const code = await init(
      join(b, "home"),
      { rotate: false },
      { out: () => {}, err: (l) => err.push(l) },
    );
    expect(code).toBe(1);
    // Said as homeProblem says it: give the directory with --home (not chmod it).
    expect(err).toEqual([TEXTS.initLink(join(b, "home"))]);
    expect(readdirSync(join(b, "real"))).toEqual([]);
  });
});
