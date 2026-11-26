// The local service's configuration, `<home>/config.toml` (docs/zh-CN/spec/06-cli.md §4.2, §6.2).
// No file: every key at its default; `saveslot init` does not write one. Read by the foreground
// entry (its values are passed to the service) and, with the same function, by `saveslot start`
// before it spawns the service and by `saveslot config get`.
//
// Every key the spec names is known here. A key in the file that is not known, or one this version
// has nothing that uses, refuses the start (exit 5) naming the key; so does a value of a used key
// that is not of its type or below its minimum, and a file that is not UTF-8 or not valid TOML.
// Nothing falls back to a default in silence. The texts name keys, lines and limits, never a value
// from the file.
//
// Used in this version: `read_log.flush_seconds` (the service's interval of writing the buffered
// reads), `mcp.autostart` (the MCP bridge; 06 §3 step 3) and `upgrade.backup` (the backup before a
// storage format upgrade; 02-architecture §8).
//
// `saveslot config set` (`setConfig`) takes those two keys only: another key in the file would
// refuse the next start. It writes the file anew from the keys it holds (a file it can write is
// one it could read: only these keys are in it), so the file's comments and layout are not kept.

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, TomlError } from "smol-toml";

export type ConfigKey =
  | "read_log.retention_days"
  | "read_log.flush_seconds"
  | "read_log.coarse_threshold"
  | "high_water.events"
  | "high_water.seconds"
  | "http.loopback"
  | "mcp.autostart"
  | "upgrade.backup";

interface IntegerKey {
  readonly kind: "integer";
  readonly default: number;
  readonly min: number;
  /** The largest value its consumer can take. */
  readonly max: number;
  readonly used: boolean;
}
interface BooleanKey {
  readonly kind: "boolean";
  readonly default: boolean;
  readonly used: boolean;
}
type KeySpec = IntegerKey | BooleanKey;

/** The largest whole number of seconds a timer takes (2^31 − 1 milliseconds). */
const MAX_TIMER_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

/** Every key, in the order `config get` lists them (06 §4.2, §2 «CLI 怎么连 saveslot», §3). */
export const KEYS: ReadonlyMap<ConfigKey, KeySpec> = new Map<ConfigKey, KeySpec>([
  [
    "read_log.retention_days",
    { kind: "integer", default: 180, min: 30, max: Number.MAX_SAFE_INTEGER, used: false },
  ],
  [
    "read_log.flush_seconds",
    { kind: "integer", default: 5, min: 1, max: MAX_TIMER_SECONDS, used: true },
  ],
  [
    "read_log.coarse_threshold",
    { kind: "integer", default: 1000, min: 1, max: Number.MAX_SAFE_INTEGER, used: false },
  ],
  [
    "high_water.events",
    { kind: "integer", default: 1000, min: 1, max: Number.MAX_SAFE_INTEGER, used: false },
  ],
  [
    "high_water.seconds",
    { kind: "integer", default: 60, min: 1, max: Number.MAX_SAFE_INTEGER, used: false },
  ],
  ["http.loopback", { kind: "boolean", default: false, used: false }],
  ["mcp.autostart", { kind: "boolean", default: true, used: true }],
  ["upgrade.backup", { kind: "boolean", default: true, used: true }],
]);

/** The tables the keys are in: `read_log`, `high_water`, `http`, `mcp`, `upgrade`. */
const SECTIONS: ReadonlySet<string> = new Set(
  [...KEYS.keys()].map((k) => k.slice(0, k.lastIndexOf("."))),
);

export type ConfigValue = number | boolean;

export interface ConfigEntry {
  readonly key: ConfigKey;
  readonly value: ConfigValue;
  readonly source: "default" | "file";
  /** Nothing in this version uses it: it can only be at its default. */
  readonly used: boolean;
}

export interface Config {
  readonly readsFlushSeconds: number;
  readonly mcpAutostart: boolean;
  /** Whether the local storage is backed up before its format is upgraded. */
  readonly upgradeBackup: boolean;
  /** Every key, in `KEYS` order. */
  readonly entries: readonly ConfigEntry[];
}

export type ConfigProblem =
  | { readonly kind: "not_utf8" }
  | { readonly kind: "not_toml"; readonly line?: number }
  | { readonly kind: "unknown_key"; readonly key: string }
  | { readonly kind: "unsupported_key"; readonly key: ConfigKey }
  | { readonly kind: "not_integer"; readonly key: ConfigKey; readonly min: number }
  | {
      readonly kind: "out_of_range";
      readonly key: ConfigKey;
      readonly min: number;
      readonly max: number;
    }
  | { readonly kind: "not_boolean"; readonly key: ConfigKey };

/** The file was there and is refused; every problem found, in the file's order. */
export class ConfigInvalid extends Error {
  override readonly name = "ConfigInvalid";
  readonly problems: readonly ConfigProblem[];
  constructor(problems: readonly ConfigProblem[]) {
    super("config.toml is not valid");
    this.problems = problems;
  }
}

export const configFile = (home: string): string => join(home, "config.toml");

const isTable = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  // A TOML date is an object too, but a value, not a table.
  (Object.getPrototypeOf(v) === null || Object.getPrototypeOf(v) === Object.prototype);

/** The leaves of a parsed document, by dotted path; a table's own keys only. */
function leaves(table: Record<string, unknown>, prefix = ""): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const k of Object.keys(table)) {
    const v = table[k];
    // A key with a dot in it (quoted in TOML) is one segment, not a path: kept apart, as written.
    const segment = k.includes(".") || k === "" ? JSON.stringify(k) : k;
    const path = prefix === "" ? segment : `${prefix}.${segment}`;
    // A table at a key's own path is that key's value, of the wrong type (`[mcp.autostart]`).
    // An empty table of a section saveslot has (`[read_log]` with its keys commented out) is
    // nothing; any other empty table is checked as a key (`[foo]` alone is one it does not know).
    if (isTable(v) && !KEYS.has(path as ConfigKey)) {
      if (Object.keys(v).length > 0) out.push(...leaves(v, path));
      else if (!SECTIONS.has(path)) out.push([path, v]);
    } else out.push([path, v]);
  }
  return out;
}

/** The configuration from the text of a `config.toml`; throws `ConfigInvalid`. */
export function parseConfig(bytes: Uint8Array): Config {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigInvalid([{ kind: "not_utf8" }]);
  }
  let doc: Record<string, unknown>;
  try {
    doc = parse(text, { integersAsBigInt: true }) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof TomlError) {
      throw new ConfigInvalid([
        { kind: "not_toml", ...(Number.isInteger(e.line) ? { line: e.line } : {}) },
      ]);
    }
    throw e;
  }
  const problems: ConfigProblem[] = [];
  const given = new Map<ConfigKey, ConfigValue>();
  for (const [path, raw] of leaves(doc)) {
    const spec = KEYS.get(path as ConfigKey);
    if (spec === undefined) {
      problems.push({ kind: "unknown_key", key: path });
      continue;
    }
    const key = path as ConfigKey;
    if (!spec.used) {
      problems.push({ kind: "unsupported_key", key });
      continue;
    }
    if (spec.kind === "boolean") {
      if (typeof raw !== "boolean") problems.push({ kind: "not_boolean", key });
      else given.set(key, raw);
      continue;
    }
    if (typeof raw !== "bigint") {
      problems.push({ kind: "not_integer", key, min: spec.min });
      continue;
    }
    if (raw < BigInt(spec.min) || raw > BigInt(spec.max)) {
      problems.push({ kind: "out_of_range", key, min: spec.min, max: spec.max });
      continue;
    }
    given.set(key, Number(raw));
  }
  if (problems.length > 0) throw new ConfigInvalid(problems);
  const entries = [...KEYS].map(([key, spec]): ConfigEntry => {
    const v = given.get(key);
    return v === undefined
      ? { key, value: spec.default, source: "default", used: spec.used }
      : { key, value: v, source: "file", used: spec.used };
  });
  const value = (key: ConfigKey) => entries.find((e) => e.key === key)?.value;
  return {
    readsFlushSeconds: value("read_log.flush_seconds") as number,
    mcpAutostart: value("mcp.autostart") as boolean,
    upgradeBackup: value("upgrade.backup") as boolean,
    entries,
  };
}

/** The home's configuration: every key at its default when there is no file. */
export async function readConfig(home: string): Promise<Config> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(configFile(home));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return parseConfig(new Uint8Array());
    throw e;
  }
  return parseConfig(bytes);
}

/** A value as `config set` takes it from the command line: its key's type and limits, or why not. */
export type SetValue =
  | { readonly ok: true; readonly value: ConfigValue }
  | { readonly ok: false; readonly problem: ConfigProblem };

/** The value written for `key` on the command line (`true` / `false`, `on` / `off`; a number). */
export function setValue(key: ConfigKey, written: string): SetValue {
  const spec = KEYS.get(key) as KeySpec;
  if (!spec.used) return { ok: false, problem: { kind: "unsupported_key", key } };
  if (spec.kind === "boolean") {
    if (written === "true" || written === "on") return { ok: true, value: true };
    if (written === "false" || written === "off") return { ok: true, value: false };
    return { ok: false, problem: { kind: "not_boolean", key } };
  }
  if (!/^(0|[1-9][0-9]*)$/.test(written)) {
    return { ok: false, problem: { kind: "not_integer", key, min: spec.min } };
  }
  const n = BigInt(written);
  if (n < BigInt(spec.min) || n > BigInt(spec.max)) {
    return { ok: false, problem: { kind: "out_of_range", key, min: spec.min, max: spec.max } };
  }
  return { ok: true, value: Number(n) };
}

/** The text of a config.toml holding the entries from the file: a table a section, in key order. */
export function configText(entries: readonly ConfigEntry[]): string {
  const sections = new Map<string, string[]>();
  for (const e of entries) {
    if (e.source !== "file") continue;
    const dot = e.key.lastIndexOf(".");
    const section = e.key.slice(0, dot);
    const lines = sections.get(section) ?? [];
    lines.push(`${e.key.slice(dot + 1)} = ${String(e.value)}`);
    sections.set(section, lines);
  }
  return [...sections].map(([s, lines]) => `[${s}]\n${lines.join("\n")}\n`).join("\n");
}

/**
 * Writes `key = value` into the home's config.toml (replaced whole, 0600). `config` is the file as
 * it was read (valid). Resolves with whether the old file held comments, which are not kept.
 */
export async function setConfig(
  home: string,
  config: Config,
  key: ConfigKey,
  value: ConfigValue,
): Promise<{ readonly commentsDropped: boolean }> {
  let old = "";
  try {
    old = await readFile(configFile(home), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const entries = config.entries.map(
    (e): ConfigEntry => (e.key === key ? { ...e, value, source: "file" } : e),
  );
  const tmp = `${configFile(home)}.tmp`;
  await writeFile(tmp, configText(entries), { mode: 0o600 });
  await rename(tmp, configFile(home));
  // A valid file holds the two keys only, a number and a boolean: a # in it starts a comment.
  return { commentsDropped: old.includes("#") };
}
