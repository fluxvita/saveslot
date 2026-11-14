// readTenantDirectory: control/tenant.json read strictly; a missing file is a home not initialized.
// Opening and closing the tenant run against a real store in the daemon's tests.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LocalTenantError, readTenantDirectory, tenantFile } from "./local-tenant.ts";

const root = mkdtempSync(join(tmpdir(), "saveslot-service-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
let n = 0;
function home(text?: string): string {
  const h = join(root, String(n++));
  mkdirSync(join(h, "control"), { recursive: true });
  if (text !== undefined) writeFileSync(tenantFile(h), text);
  return h;
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof LocalTenantError) return e.code;
    throw e;
  }
  return "read";
}

describe("readTenantDirectory", () => {
  it("reads the user and the tenant", async () => {
    const h = home(JSON.stringify({ format: 1, user: USER, tenant: TENANT }));
    expect(await readTenantDirectory(h)).toEqual({ user: USER, tenant: TENANT });
  });

  it("reports a home without the file as not initialized", async () => {
    expect(await code(readTenantDirectory(home()))).toBe("not_initialized");
    expect(await code(readTenantDirectory(join(root, "absent")))).toBe("not_initialized");
  });

  it.each<[string, string]>([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["null", "null"],
    ["another format", JSON.stringify({ format: 2, user: USER, tenant: TENANT })],
    ["a key missing", JSON.stringify({ format: 1, tenant: TENANT })],
    ["an extra key", JSON.stringify({ format: 1, user: USER, tenant: TENANT, x: 1 })],
    ["a key of the prototype", `{"format":1,"user":"${USER}","tenant":"${TENANT}","__proto__":{}}`],
    ["a tenant ID of another kind", JSON.stringify({ format: 1, user: USER, tenant: USER })],
    [
      "a tenant ID in lower case",
      JSON.stringify({ format: 1, user: USER, tenant: TENANT.replace("8", "a").toLowerCase() }),
    ],
    ["a user ID that is no ID", JSON.stringify({ format: 1, user: "u_x", tenant: TENANT })],
    ["a number for the tenant", JSON.stringify({ format: 1, user: USER, tenant: 1 })],
  ])("refuses %s as corrupt", async (_, text) => {
    expect(await code(readTenantDirectory(home(text)))).toBe("tenant_directory_corrupt");
  });
});
