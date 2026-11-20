// The local service's configuration, config.toml (06-cli §4.2, §6.2): the keys and their checks,
// what `saveslot start`, the foreground entry and `saveslot config get` do with it.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalHome } from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import { configCommand, start } from "./commands.ts";
import {
  ConfigInvalid,
  type ConfigProblem,
  configFile,
  KEYS,
  parseConfig,
  readConfig,
} from "./config.ts";
import { health } from "./local-request.ts";
import { foregroundOptions, main } from "./main.ts";
import { pidFile, socketFile } from "./service.ts";
import { TEXTS } from "./texts.ts";

const toml = (s: string) => new TextEncoder().encode(s);

/** The problems a file is refused for. */
function problems(text: string | Uint8Array): readonly ConfigProblem[] {
  try {
    parseConfig(typeof text === "string" ? toml(text) : text);
  } catch (e) {
    if (e instanceof ConfigInvalid) return e.problems;
    throw e;
  }
  throw new Error("the file was taken");
}

const UNUSED = [
  "read_log.retention_days",
  "read_log.coarse_threshold",
  "high_water.events",
  "high_water.seconds",
  "http.loopback",
] as const;

describe("parsing config.toml", () => {
  it("an empty file: every key at its default, in order, with whether this version uses it", () => {
    const c = parseConfig(toml(""));
    expect(c.readsFlushSeconds).toBe(5);
    expect(c.mcpAutostart).toBe(true);
    expect(c.entries).toEqual([
      { key: "read_log.retention_days", value: 180, source: "default", used: false },
      { key: "read_log.flush_seconds", value: 5, source: "default", used: true },
      { key: "read_log.coarse_threshold", value: 1000, source: "default", used: false },
      { key: "high_water.events", value: 1000, source: "default", used: false },
      { key: "high_water.seconds", value: 60, source: "default", used: false },
      { key: "http.loopback", value: false, source: "default", used: false },
      { key: "mcp.autostart", value: true, source: "default", used: true },
    ]);
  });

  it("the keys in use, as a table or dotted, at their limits", () => {
    for (const text of [
      "[read_log]\nflush_seconds = 7\n[mcp]\nautostart = false\n",
      "read_log.flush_seconds = 7\nmcp.autostart = false\n",
    ]) {
      const c = parseConfig(toml(text));
      expect(c.readsFlushSeconds).toBe(7);
      expect(c.mcpAutostart).toBe(false);
      expect(c.entries.find((e) => e.key === "read_log.flush_seconds")?.source).toBe("file");
      expect(c.entries.find((e) => e.key === "mcp.autostart")?.source).toBe("file");
    }
    expect(parseConfig(toml("read_log.flush_seconds = 1")).readsFlushSeconds).toBe(1);
    expect(parseConfig(toml("read_log.flush_seconds = 2147483")).readsFlushSeconds).toBe(2147483);
    expect(parseConfig(toml("read_log.flush_seconds = 0x10")).readsFlushSeconds).toBe(16);
  });

  it("a key saveslot does not know: refused, named", () => {
    expect(problems("read_log.flush_second = 5")).toEqual([
      { kind: "unknown_key", key: "read_log.flush_second" },
    ]);
    expect(problems("[http]\nport = 8080")).toEqual([{ kind: "unknown_key", key: "http.port" }]);
    expect(problems("read_log = 5")).toEqual([{ kind: "unknown_key", key: "read_log" }]);
    expect(problems("[[mcp]]\nautostart = true")).toEqual([{ kind: "unknown_key", key: "mcp" }]);
    expect(problems("[foo]\n[read_log]\n")).toEqual([{ kind: "unknown_key", key: "foo" }]);
    expect(problems('"read_log.flush_seconds" = 5')).toEqual([
      { kind: "unknown_key", key: '"read_log.flush_seconds"' },
    ]);
    expect(problems('mcp."" = 1')).toEqual([{ kind: "unknown_key", key: 'mcp.""' }]);
    // A section saveslot has, its keys commented out: nothing.
    expect(parseConfig(toml("[read_log]\n# flush_seconds = 5\n[mcp]\n")).readsFlushSeconds).toBe(5);
    for (const k of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(problems(`${k} = 1`)).toEqual([{ kind: "unknown_key", key: k }]);
      expect(problems(`mcp.${k} = 1`)).toEqual([{ kind: "unknown_key", key: `mcp.${k}` }]);
    }
  });

  it("a key the spec has and this version does not use: refused as not supported, at any value", () => {
    for (const key of UNUSED) {
      const value = KEYS.get(key)?.kind === "boolean" ? "true" : "100";
      expect(problems(`${key} = ${value}`)).toEqual([{ kind: "unsupported_key", key }]);
      expect(problems(`${key} = "not even its type"`)).toEqual([{ kind: "unsupported_key", key }]);
    }
  });

  it("an integer key: a whole number within its limits, nothing else", () => {
    const key = "read_log.flush_seconds";
    for (const v of ["5.0", "5.5", '"5"', "true", "2026-01-01", "inf", "nan", "[5]", "{ a = 5 }"]) {
      expect(problems(`${key} = ${v}`)).toEqual([{ kind: "not_integer", key, min: 1 }]);
    }
    for (const v of ["0", "-1", "2147484", "9223372036854775807"]) {
      expect(problems(`${key} = ${v}`)).toEqual([
        { kind: "out_of_range", key, min: 1, max: 2147483 },
      ]);
    }
  });

  it("a boolean key: true or false, nothing else", () => {
    for (const v of ['"true"', "1", "0", "2026-01-01T00:00:00Z"]) {
      expect(problems(`mcp.autostart = ${v}`)).toEqual([
        { kind: "not_boolean", key: "mcp.autostart" },
      ]);
    }
    expect(problems("[mcp.autostart]")).toEqual([{ kind: "not_boolean", key: "mcp.autostart" }]);
  });

  it("not UTF-8, or not valid TOML (a key twice, a table and a key of one name): refused, with the line", () => {
    expect(problems(new Uint8Array([0x6d, 0x3d, 0xff, 0x0a]))).toEqual([{ kind: "not_utf8" }]);
    expect(problems("mcp.autostart = true\nmcp.autostart = false")).toEqual([
      { kind: "not_toml", line: 2 },
    ]);
    expect(problems("mcp = 1\n[mcp]\nautostart = true")).toEqual([{ kind: "not_toml", line: 2 }]);
    expect(problems("[read_log]\nflush_seconds = 5\n[read_log]\n")).toEqual([
      { kind: "not_toml", line: 3 },
    ]);
    expect(problems("this is = not = toml")).toEqual([{ kind: "not_toml", line: 1 }]);
  });

  it("every problem is reported, in the file's order", () => {
    expect(
      problems('a = 1\nread_log.flush_seconds = 0\nhttp.loopback = true\nmcp.autostart = "no"'),
    ).toEqual([
      { kind: "unknown_key", key: "a" },
      { kind: "out_of_range", key: "read_log.flush_seconds", min: 1, max: 2147483 },
      { kind: "unsupported_key", key: "http.loopback" },
      { kind: "not_boolean", key: "mcp.autostart" },
    ]);
  });

  it("the texts name keys and limits, never a value from the file", () => {
    const marker = "zq-value-4410";
    const found = problems(
      [
        `read_log.flush_seconds = "${marker}"`,
        `mcp.autostart = "${marker}"`,
        `read_log.retention_days = "${marker}"`,
        `unknown.key = "${marker}"`,
      ].join("\n"),
    );
    const text = [TEXTS.configInvalid, ...found.map(TEXTS.configProblem)].join("\n");
    expect(text).not.toContain(marker);
    for (const k of ["read_log.flush_seconds", "mcp.autostart", "read_log.retention_days"]) {
      expect(text).toContain(k);
    }
    expect(text).toContain("not supported in this version");
    expect(TEXTS.configProblem({ kind: "not_toml", line: 3 })).toContain("line 3");
  });
});

describe("the configuration of a home", () => {
  const root = mkdtempSync(join(tmpdir(), "saveslot-config-"));
  const home = join(root, "home");
  beforeAll(async () => {
    await initLocalHome({
      home,
      backend: testBackend(),
      lock: osFileLock,
      now: new Date().toISOString(),
    });
  }, 60_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  };

  it("init writes no config.toml; with none, every key is at its default", async () => {
    expect(existsSync(configFile(home))).toBe(false);
    const c = await readConfig(home);
    expect(c.entries.every((e) => e.source === "default")).toBe(true);
  });

  it("the foreground service runs with the file's read flush interval", async () => {
    writeFileSync(configFile(home), "read_log.flush_seconds = 7\n");
    try {
      expect((await foregroundOptions(home)).readsFlushMs).toBe(7000);
    } finally {
      rmSync(configFile(home));
    }
    expect((await foregroundOptions(home)).readsFlushMs).toBe(5000);
  });

  it("config get: each key, its value in effect and where it comes from", async () => {
    writeFileSync(configFile(home), "[mcp]\nautostart = false\n");
    try {
      const a = io();
      expect(await configCommand(home, ["get"], a.io)).toBe(0);
      expect(a.out).toEqual([
        "read_log.retention_days = 180  (default; not in use in this version)",
        "read_log.flush_seconds = 5  (default)",
        "read_log.coarse_threshold = 1000  (default; not in use in this version)",
        "high_water.events = 1000  (default; not in use in this version)",
        "high_water.seconds = 60  (default; not in use in this version)",
        "http.loopback = false  (default; not in use in this version)",
        "mcp.autostart = false  (config.toml)",
      ]);
      const b = io();
      expect(await configCommand(home, ["get", "mcp.autostart"], b.io)).toBe(0);
      expect(b.out).toEqual(["mcp.autostart = false  (config.toml)"]);
    } finally {
      rmSync(configFile(home));
    }
  });

  it("config get: a key it does not know, or no verb: usage, exit 2", async () => {
    for (const args of [["get", "nope"], [], ["get", "a", "b"], ["put", "mcp.autostart"]]) {
      const a = io();
      expect(await configCommand(home, args, a.io)).toBe(2);
      expect(a.out).toEqual([]);
    }
  });

  it("config set: the key written, the file a table a section, 0600; get reads it back", async () => {
    try {
      const a = io();
      expect(await configCommand(home, ["set", "mcp.autostart", "off"], a.io)).toBe(0);
      expect(a.out).toEqual([
        "mcp.autostart = false  (written to config.toml)",
        TEXTS.configTakesEffectBridge,
      ]);
      const b = io();
      expect(await configCommand(home, ["set", "read_log.flush_seconds", "9"], b.io)).toBe(0);
      // No service runs on this home.
      expect(b.out).toEqual([
        "read_log.flush_seconds = 9  (written to config.toml)",
        TEXTS.configTakesEffectStart,
      ]);
      expect(readFileSync(configFile(home), "utf8")).toBe(
        "[read_log]\nflush_seconds = 9\n\n[mcp]\nautostart = false\n",
      );
      expect(statSync(configFile(home)).mode & 0o777).toBe(0o600);
      const c = await readConfig(home);
      expect([c.readsFlushSeconds, c.mcpAutostart]).toEqual([9, false]);
      // The same key again: replaced, not added twice.
      await configCommand(home, ["set", "mcp.autostart", "true"], io().io);
      expect((await readConfig(home)).mcpAutostart).toBe(true);
      expect(existsSync(`${configFile(home)}.tmp`)).toBe(false);
    } finally {
      rmSync(configFile(home), { force: true });
    }
  });

  it("config set: comments in the file are said to be dropped", async () => {
    writeFileSync(configFile(home), "# mine\n[mcp]\nautostart = true # yes\n");
    try {
      const a = io();
      expect(await configCommand(home, ["set", "read_log.flush_seconds", "3"], a.io)).toBe(0);
      expect(a.out).toContain(TEXTS.configCommentsDropped);
      expect(readFileSync(configFile(home), "utf8")).not.toContain("#");
      expect((await readConfig(home)).mcpAutostart).toBe(true);
    } finally {
      rmSync(configFile(home), { force: true });
    }
  });

  it("config set: a key not in use, a value not of its type or limits, a key unknown: 2, nothing written", async () => {
    for (const [args, says] of [
      [["read_log.retention_days", "60"], "read_log.retention_days: not supported in this version"],
      [["http.loopback", "on"], "http.loopback: not supported in this version"],
      [["read_log.flush_seconds", "0"], "read_log.flush_seconds: must be at least 1 and at most"],
      [["read_log.flush_seconds", "2147484"], "must be at least 1 and at most 2147483"],
      [["read_log.flush_seconds", "5s"], "read_log.flush_seconds: must be a whole number"],
      [["read_log.flush_seconds", "05"], "must be a whole number"],
      [["mcp.autostart", "yes"], "mcp.autostart: must be true or false"],
      [["nope", "1"], "nope is not a key saveslot knows"],
      [["mcp.autostart"], "saveslot config set <key> <value>"],
      [["mcp.autostart", "true", "x"], "saveslot config set <key> <value>"],
    ] as const) {
      const a = io();
      expect(await configCommand(home, ["set", ...args], a.io)).toBe(2);
      expect(a.err.join("\n")).toContain(says);
      expect(a.out).toEqual([]);
      expect(existsSync(configFile(home))).toBe(false);
    }
  });

  it("config set on a refused file: 5, the file left as it was", async () => {
    const text = "read_log.flush_seconds = 0\n";
    writeFileSync(configFile(home), text);
    try {
      const a = io();
      expect(await configCommand(home, ["set", "mcp.autostart", "false"], a.io)).toBe(5);
      expect(a.err[0]).toBe(TEXTS.configInvalid);
      expect(readFileSync(configFile(home), "utf8")).toBe(text);
    } finally {
      rmSync(configFile(home));
    }
  });

  it("a refused file: config get and start exit 5 naming the key; start spawns nothing", async () => {
    writeFileSync(configFile(home), "read_log.flush_seconds = 0\nhttp.loopback = true\n");
    try {
      const g = io();
      expect(await configCommand(home, ["get"], g.io)).toBe(5);
      expect(g.out).toEqual([]);
      expect(g.err.join("\n")).toContain("read_log.flush_seconds: must be at least 1");
      const s = io();
      expect(await start(home, s.io)).toBe(5);
      expect(s.err[0]).toBe(TEXTS.configInvalid);
      expect(s.err.join("\n")).toContain("http.loopback: not supported in this version");
      expect(existsSync(pidFile(home))).toBe(false);
      expect(existsSync(join(home, "run", "saveslot.log"))).toBe(false);
      expect(await health(socketFile(home))).toBeUndefined();
    } finally {
      rmSync(configFile(home));
    }
  });

  for (const tty of [false, true]) {
    it(`a refused file in the foreground, stderr ${tty ? "a terminal" : "the log"}: exit 5; known keys by name, unknown ones counted, no value`, async () => {
      const marker = "zq-value-8113";
      writeFileSync(configFile(home), `mcp.autostart = "${marker}"\nzz_user_key = 1\n`);
      const written: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
        written.push(String(c));
        return true;
      });
      const was = process.stderr.isTTY;
      process.stderr.isTTY = tty;
      try {
        expect(await main(["--home", home])).toBe(5);
      } finally {
        process.stderr.isTTY = was;
        spy.mockRestore();
        rmSync(configFile(home));
      }
      const text = written.join("");
      expect(text).toMatch(/^\S+ config_invalid keys=mcp\.autostart unknown_keys=1\n/);
      expect(text).not.toContain(marker);
      // The texts, which name every key, only to a terminal.
      expect(text.includes(TEXTS.configInvalid)).toBe(tty);
      expect(text.includes("zz_user_key")).toBe(tty);
      expect(existsSync(pidFile(home))).toBe(false);
    });
  }
});
