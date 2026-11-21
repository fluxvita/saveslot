// readTenantDirectory: control/tenant.json read strictly; a missing file is a home not initialized.
// Opening and closing the tenant run against a real store in the daemon's tests.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LocalTenantError, readTenantDirectory, tenantFile } from "./local-tenant.ts";

const root = mkdtempSync(join(tmpdir(), "saveslot-service-"));
// Removing the temporary directory can pass the default 10 s hook time under load.
afterAll(() => rm(root, { recursive: true, force: true }), 60_000);

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
  it("reads the user and the tenant; the data directory is <home>/data", async () => {
    const h = home(JSON.stringify({ format: 1, user: USER, tenant: TENANT }));
    expect(await readTenantDirectory(h)).toEqual({
      user: USER,
      tenant: TENANT,
      dataDir: join(h, "data"),
    });
  });

  it("gives an absolute default data directory for a home given relative", async () => {
    const h = home(JSON.stringify({ format: 1, user: USER, tenant: TENANT }));
    const rel = relative(process.cwd(), h);
    expect((await readTenantDirectory(rel)).dataDir).toBe(join(h, "data"));
  });

  it("reads a data directory recorded as an absolute path", async () => {
    const h = home(
      JSON.stringify({ format: 1, user: USER, tenant: TENANT, data_dir: "/x/y data" }),
    );
    expect((await readTenantDirectory(h)).dataDir).toBe("/x/y data");
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
    ...(["data", "./data", "", "~/data"] as const).map((d): [string, string] => [
      `a relative data directory ${JSON.stringify(d)}`,
      JSON.stringify({ format: 1, user: USER, tenant: TENANT, data_dir: d }),
    ]),
    ...([1, null, ["/x"], { path: "/x" }] as const).map((d): [string, string] => [
      `a data directory that is no string (${JSON.stringify(d)})`,
      JSON.stringify({ format: 1, user: USER, tenant: TENANT, data_dir: d }),
    ]),
  ])("refuses %s as corrupt", async (_, text) => {
    expect(await code(readTenantDirectory(home(text)))).toBe("tenant_directory_corrupt");
  });
});
