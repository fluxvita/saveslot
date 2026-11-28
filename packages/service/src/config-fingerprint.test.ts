// The deployment's configuration fingerprint (06-cli §4.1 «各进程相同的配置»): each setting told
// apart on its own, lists taken as sets, nothing of a value kept; recorded once, rewritten by a
// process holding the server lock alone, refused to any other. Fictional settings.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenantStore } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../test-backend/src/index.fixture.ts";
import {
  ConfigFingerprintMismatch,
  checkConfigFingerprint,
  differences,
  FINGERPRINT_ITEMS,
  type FingerprintInput,
  fingerprintOf,
  parseFingerprint,
} from "./config-fingerprint.ts";
import { initControlPlane } from "./server-control-plane.ts";

const T = 120_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-fingerprint-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);

const BASE: FingerprintInput = {
  trustedProxies: ["10.0.0.0/8", "192.0.2.10"],
  publicUrl: "https://saveslot.example",
  allowedOrigins: ["https://app.example", "https://other.example"],
  handleKeyIds: ["k1111111111111111", "k2222222222222222"],
  cell: { by: "system_identifier", value: "7712000000000000001" },
};

describe("the fingerprint of a process's settings", () => {
  it("each setting changed alone differs in its item only", () => {
    const base = fingerprintOf(BASE);
    const changed: [FingerprintInput, string][] = [
      [{ ...BASE, trustedProxies: ["10.0.0.0/8"] }, "trusted_proxies"],
      [{ ...BASE, publicUrl: "https://saveslot.example:8443" }, "public_url"],
      [{ ...BASE, allowedOrigins: [] }, "allowed_origins"],
      [
        {
          ...BASE,
          identity: { issuer: "https://idp.example", loginUrl: "https://idp.example/l", kids: [] },
        },
        "identity",
      ],
      [{ ...BASE, handleKeyIds: ["k1111111111111111"] }, "handle_keys"],
      [{ ...BASE, cell: { by: "system_identifier", value: "7712000000000000002" } }, "cell"],
    ];
    for (const [input, item] of changed) {
      expect(differences(base, fingerprintOf(input))).toEqual([{ item }]);
    }
    expect(changed.map(([, i]) => i)).toEqual([...FINGERPRINT_ITEMS]);
  });

  it("a list's order and repeats change nothing; the external login's key IDs are a set too", () => {
    const idp = { issuer: "https://idp.example", loginUrl: "https://idp.example/l" };
    const a = fingerprintOf({ ...BASE, identity: { ...idp, kids: ["a", "b"] } });
    const b = fingerprintOf({
      ...BASE,
      trustedProxies: [...BASE.trustedProxies].reverse(),
      allowedOrigins: [...BASE.allowedOrigins, ...BASE.allowedOrigins],
      handleKeyIds: [...BASE.handleKeyIds].reverse(),
      identity: { ...idp, kids: ["b", "a", "b"] },
    });
    expect(b).toEqual(a);
    // Another key of the platform is another setting.
    const c = fingerprintOf({ ...BASE, identity: { ...idp, kids: ["a", "b", "c"] } });
    expect(differences(a, c)).toEqual([{ item: "identity" }]);
  });

  it("the cell told apart another way differs, and says the two ways", () => {
    const here = fingerprintOf({ ...BASE, cell: { by: "url", value: "db.example:5432/postgres" } });
    expect(differences(fingerprintOf(BASE), here)).toEqual([
      { item: "cell", ways: { recorded: "system_identifier", here: "url" } },
    ]);
  });

  it("keeps no value: what is recorded holds none of the settings", () => {
    const text = JSON.stringify(fingerprintOf(BASE));
    for (const v of [
      ...BASE.trustedProxies,
      BASE.publicUrl,
      "saveslot.example",
      ...BASE.allowedOrigins,
      ...BASE.handleKeyIds,
      BASE.cell.value,
    ]) {
      expect(text).not.toContain(v);
    }
    expect(parseFingerprint(text)).toEqual(fingerprintOf(BASE));
  });

  it("a record not of its form is not read", () => {
    const good = fingerprintOf(BASE);
    for (const bad of [
      "",
      "null",
      "[]",
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, extra: 1 }),
      JSON.stringify({ v: 1, items: { ...good.items, public_url: "x" } }),
      JSON.stringify({ v: 1, items: { ...good.items, cell: good.items.public_url } }),
      JSON.stringify({ v: 1, items: { ...good.items, more: good.items.public_url } }),
    ]) {
      expect(parseFingerprint(bad)).toBeUndefined();
    }
  });
});

describe("checking it against the control database's", () => {
  let db: TenantStore;
  beforeAll(async () => {
    db = await testBackend().open({ kind: "pglite", dir: join(root, "control") }, { create: true });
    await initControlPlane(db);
  }, T);
  afterAll(() => db?.close(), T);

  const recorded = async () =>
    (
      await db.read((tx) =>
        tx.query<{ value: string }>(
          "SELECT value FROM control_meta WHERE key = 'config_fingerprint'",
        ),
      )
    ).rows[0]?.value;

  it(
    "written when none is there; the same: nothing; different: refused unless alone, then rewritten",
    async () => {
      const a = fingerprintOf(BASE);
      const b = fingerprintOf({ ...BASE, allowedOrigins: ["https://app.example"] });
      expect(await checkConfigFingerprint(db, a, { exclusive: false })).toEqual({
        kind: "written",
      });
      expect(await recorded()).toBe(JSON.stringify(a));
      expect(await checkConfigFingerprint(db, a, { exclusive: false })).toEqual({ kind: "same" });
      const refused = await checkConfigFingerprint(db, b, { exclusive: false }).catch(
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(ConfigFingerprintMismatch);
      expect((refused as ConfigFingerprintMismatch).differences).toEqual([
        { item: "allowed_origins" },
      ]);
      expect((refused as Error).message).not.toContain("app.example");
      expect(await recorded()).toBe(JSON.stringify(a));
      expect(await checkConfigFingerprint(db, b, { exclusive: true })).toEqual({
        kind: "rewritten",
        differences: [{ item: "allowed_origins" }],
      });
      expect(await recorded()).toBe(JSON.stringify(b));
      // A record not of its form: every setting differs.
      await db.write((tx) =>
        tx.query("UPDATE control_meta SET value = 'x' WHERE key = 'config_fingerprint'"),
      );
      const all = await checkConfigFingerprint(db, b, { exclusive: false }).catch(
        (e: unknown) => e,
      );
      expect((all as ConfigFingerprintMismatch).differences.map((d) => d.item)).toEqual([
        ...FINGERPRINT_ITEMS,
      ]);
      expect(await checkConfigFingerprint(db, b, { exclusive: true })).toMatchObject({
        kind: "rewritten",
      });
    },
    T,
  );
});
