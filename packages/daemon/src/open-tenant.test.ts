// Opening the local tenant loads the restricted SQL parser (02-architecture §4 `openTenant`): a
// tenant that serves can evaluate derived rules (read a derived table, refresh one, replay a derived
// write) without a schema document submitted first in this process. Each test file runs in a module
// graph of its own, so the parser is not loaded before the tenant is opened here.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLocalTenant, openLocalTenant } from "@fluxvita/saveslot-service";
import { createLocalHome, isRsqlLoaded } from "@fluxvita/saveslot-service/testing";
import { PgliteBackend } from "@fluxvita/saveslot-store-pglite";
import { afterAll, describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "saveslot-open-tenant-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("opening the local tenant", () => {
  it("loads the restricted SQL parser before the tenant serves", async () => {
    const home = join(root, "h");
    const dataDir = await createLocalHome(home, new PgliteBackend());
    expect(isRsqlLoaded()).toBe(false);
    const r = await openLocalTenant({ home, dataDir, backend: new PgliteBackend() });
    if (!r.ok) throw new Error(r.failure);
    try {
      expect(isRsqlLoaded()).toBe(true);
    } finally {
      await closeLocalTenant(r.tenant);
    }
  }, 60_000);
});
