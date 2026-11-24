// The deletion confirmation handle `dc_…` (02-architecture §5; 04-contract §15: 10 minutes): what
// the kernel's preview binds, signed for one principal of one tenant with the handle keys; taken
// back only with a good signature, by the same principal of the same tenant, before it expires.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CONFIRM_TTL_MS, CursorKeys } from "./cursor.ts";

const root = mkdtempSync(join(tmpdir(), "saveslot-confirm-handle-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const home = () => join(root, `h${++n}`);

const NOW = "2026-11-24T10:00:00.000Z";
const TENANT = `tn_${"3".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const BINDING = {
  deletion: `pi_${"4".repeat(16)}`,
  slot: "sl_X",
  sources: ["s_1"],
  hash: "c".repeat(64),
  seq: 42,
  restoreCount: 0,
};

const thrown = (
  f: () => unknown,
): { code?: string; detail?: { reason?: string; param?: string } } => {
  try {
    f();
  } catch (e) {
    return e as never;
  }
  return {};
};

describe("the confirmation handle", () => {
  it("gives back what it binds, expired from 10 minutes after it was given", async () => {
    const keys = await CursorKeys.open(home(), NOW);
    const { handle, expiresAt } = keys.signConfirm(BINDING, TENANT, USER, NOW);
    expect(handle).toMatch(/^dc_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(expiresAt) - Date.parse(NOW)).toBe(CONFIRM_TTL_MS);
    expect(keys.verifyConfirm(handle, TENANT, USER, NOW)).toEqual({
      binding: BINDING,
      expired: false,
    });
    const last = new Date(Date.parse(expiresAt) - 1).toISOString();
    expect(keys.verifyConfirm(handle, TENANT, USER, last)).toEqual({
      binding: BINDING,
      expired: false,
    });
    // Past its expiry: given back, marked expired (a handle confirmed already is answered first).
    expect(keys.verifyConfirm(handle, TENANT, USER, expiresAt)).toEqual({
      binding: BINDING,
      expired: true,
    });
  });

  it("another principal, another tenant, another signature, a paging handle: not one of this service's", async () => {
    const keys = await CursorKeys.open(home(), NOW);
    const { handle } = keys.signConfirm(BINDING, TENANT, USER, NOW);
    const malformed = (h: unknown, tenant = TENANT, user = USER) => {
      const e = thrown(() => keys.verifyConfirm(h, tenant, user, NOW));
      expect([e.code, e.detail?.reason, e.detail?.param]).toEqual([
        "invalid_argument",
        "malformed",
        "confirm",
      ]);
    };
    malformed(handle, TENANT, `u_${"2".repeat(26)}`);
    malformed(handle, `tn_${"4".repeat(26)}`);
    // The binding changed, the signature kept.
    const [payload, mac] = handle.slice(3).split(".") as [string, string];
    const o = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const forged = Buffer.from(
      JSON.stringify({ ...o, b: { ...o.b, hash: "d".repeat(64) } }),
      "utf8",
    ).toString("base64url");
    malformed(`dc_${forged}.${mac}`);
    // Another key's signature.
    const other = await CursorKeys.open(home(), NOW);
    malformed(other.signConfirm(BINDING, TENANT, USER, NOW).handle);
    // A paging handle's payload and signature under the confirmation's prefix: the MAC is of
    // another domain.
    const cur = keys.sign("p", USER, NOW);
    malformed(`dc_${cur.slice(4)}`);
    malformed(undefined);
    malformed("dc_");
  });

  it("binds a thousand sources: the handle is given and taken back", async () => {
    const keys = await CursorKeys.open(home(), NOW);
    const many = {
      ...BINDING,
      sources: Array.from({ length: 1000 }, (_, i) => `s_${String(i).padStart(16, "0")}`),
    };
    const { handle } = keys.signConfirm(many, TENANT, USER, NOW);
    expect(keys.verifyConfirm(handle, TENANT, USER, NOW).binding).toEqual(many);
  });
});
