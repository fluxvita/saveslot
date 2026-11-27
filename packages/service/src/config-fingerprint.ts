// The server mode's configuration fingerprint (06-cli §4.1 «各进程相同的配置»): the settings
// every process of a deployment must share, each hashed, recorded as `control_meta`'s
// `config_fingerprint`. A process starting compares its own with the one recorded: one holding the
// server lock alone writes or rewrites it (the deployment was stopped for the change), any other is
// refused when they differ, told which settings. Only hashes are recorded: no setting's value is
// kept in the control database, and a refusal names settings, never values.
//
// The cell's item says how the cell was told apart besides its hash (`system_identifier:` or
// `url:`): two processes telling it apart differently differ in that item, as two processes
// pointed at two clusters do, and the refusal says the ways differ.

import { createHash } from "node:crypto";
import type { ControlDb } from "./server-control-plane.ts";

/** The settings, in the order a refusal names them. */
export const FINGERPRINT_ITEMS = [
  "trusted_proxies",
  "public_url",
  "allowed_origins",
  "identity",
  "handle_keys",
  "cell",
] as const;

export type FingerprintItem = (typeof FINGERPRINT_ITEMS)[number];

/** How the cell was told apart: its cluster's system identifier, or its address when not readable. */
export type CellIdentity =
  | { readonly by: "system_identifier"; readonly value: string }
  | { readonly by: "url"; readonly value: string };

/** What a process's settings come to, in the forms hashed (each list's order and repeats ignored). */
export interface FingerprintInput {
  readonly trustedProxies: readonly string[];
  readonly publicUrl: string;
  readonly allowedOrigins: readonly string[];
  /** Absent: the local accounts. */
  readonly identity?: {
    readonly issuer: string;
    readonly loginUrl: string;
    readonly kids: readonly string[];
  };
  /** The handle key file's key IDs (never the keys). */
  readonly handleKeyIds: readonly string[];
  readonly cell: CellIdentity;
}

export interface ConfigFingerprint {
  readonly v: 1;
  readonly items: Readonly<Record<FingerprintItem, string>>;
}

const sha256 = (v: unknown): string =>
  createHash("sha256").update(JSON.stringify(v), "utf8").digest("hex");

const set = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/** The fingerprint of a process's settings. */
export function fingerprintOf(c: FingerprintInput): ConfigFingerprint {
  return {
    v: 1,
    items: {
      trusted_proxies: sha256(set(c.trustedProxies)),
      public_url: sha256(c.publicUrl),
      allowed_origins: sha256(set(c.allowedOrigins)),
      identity: sha256(
        c.identity === undefined
          ? "local"
          : ["external", c.identity.issuer, c.identity.loginUrl, set(c.identity.kids)],
      ),
      handle_keys: sha256(set(c.handleKeyIds)),
      cell: `${c.cell.by}:${sha256(c.cell.value)}`,
    },
  };
}

const ITEM = /^[0-9a-f]{64}$/;
const CELL_ITEM = /^(system_identifier|url):[0-9a-f]{64}$/;

/** A recorded fingerprint read back; undefined when it is not of this form. */
export function parseFingerprint(text: string): ConfigFingerprint | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "items,v" || o["v"] !== 1) return undefined;
  const items = o["items"];
  if (items === null || typeof items !== "object" || Array.isArray(items)) return undefined;
  const it = items as Record<string, unknown>;
  if (Object.keys(it).sort().join(",") !== [...FINGERPRINT_ITEMS].sort().join(",")) {
    return undefined;
  }
  for (const k of FINGERPRINT_ITEMS) {
    const x = it[k];
    if (typeof x !== "string" || !(k === "cell" ? CELL_ITEM : ITEM).test(x)) return undefined;
  }
  return { v: 1, items: it as Record<FingerprintItem, string> };
}

/** A difference: the setting, and for the cell whether the ways it was told apart differ. */
export interface FingerprintDifference {
  readonly item: FingerprintItem;
  /** The cell only: told apart one way here and the other in the record. */
  readonly ways?: { readonly recorded: string; readonly here: string };
}

/** The settings that differ, in `FINGERPRINT_ITEMS`' order. */
export function differences(
  recorded: ConfigFingerprint,
  here: ConfigFingerprint,
): FingerprintDifference[] {
  const out: FingerprintDifference[] = [];
  for (const item of FINGERPRINT_ITEMS) {
    const a = recorded.items[item];
    const b = here.items[item];
    if (a === b) continue;
    if (item === "cell") {
      const wa = a.slice(0, a.indexOf(":"));
      const wb = b.slice(0, b.indexOf(":"));
      out.push(wa === wb ? { item } : { item, ways: { recorded: wa, here: wb } });
    } else out.push({ item });
  }
  return out;
}

/** A process whose settings differ from the recorded ones, not holding the server lock alone. */
export class ConfigFingerprintMismatch extends Error {
  override readonly name = "ConfigFingerprintMismatch";
  readonly code = "config_fingerprint_mismatch";
  readonly differences: readonly FingerprintDifference[];
  constructor(differences: readonly FingerprintDifference[]) {
    super(
      `this process's settings differ from the deployment's: ${differences.map((d) => d.item).join(", ")}`,
    );
    this.differences = differences;
  }
}

/** What the check did. */
export type FingerprintCheck =
  | { readonly kind: "written" }
  | { readonly kind: "same" }
  | { readonly kind: "rewritten"; readonly differences: readonly FingerprintDifference[] };

const KEY = "config_fingerprint";

/**
 * Compares the process's fingerprint with the recorded one. None recorded: written. The same:
 * nothing. Different (or a record not of its form, every setting then differing): rewritten when
 * `exclusive` (the caller holds the server lock alone: no other process runs), else refused with
 * `ConfigFingerprintMismatch`, nothing written.
 */
export async function checkConfigFingerprint(
  db: ControlDb,
  here: ConfigFingerprint,
  o: { readonly exclusive: boolean },
): Promise<FingerprintCheck> {
  return await db.write(async (tx) => {
    const r = await tx.query<{ value: string }>(
      "SELECT value FROM control_meta WHERE key = $1 FOR UPDATE",
      [KEY],
    );
    const text = r.rows[0]?.value;
    const value = JSON.stringify(here);
    if (text === undefined) {
      await tx.query("INSERT INTO control_meta (key, value) VALUES ($1, $2)", [KEY, value]);
      return { kind: "written" };
    }
    const recorded = parseFingerprint(text);
    const diff =
      recorded === undefined
        ? FINGERPRINT_ITEMS.map((item) => ({ item }))
        : differences(recorded, here);
    if (diff.length === 0) return { kind: "same" };
    if (!o.exclusive) throw new ConfigFingerprintMismatch(diff);
    await tx.query("UPDATE control_meta SET value = $2 WHERE key = $1", [KEY, value]);
    return { kind: "rewritten", differences: diff };
  });
}
