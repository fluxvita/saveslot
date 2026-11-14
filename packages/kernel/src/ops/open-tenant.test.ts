// openTenantDecision: the order of 02-architecture §4 `openTenant` steps 1–3.

import { describe, expect, it } from "vitest";
import { openTenantDecision } from "./open-tenant.ts";

const IMPORT = `im_${"1".repeat(16)}` as never;
const RESTORE = `rs_${"2".repeat(16)}` as never;

describe("openTenantDecision", () => {
  it("serves when no marker is set and the log reaches the high water", () => {
    expect(openTenantDecision({ logEnd: 1 as never, highWater: 0 })).toEqual({ kind: "serve" });
    expect(openTenantDecision({ logEnd: 40 as never, highWater: 40 as never })).toEqual({
      kind: "serve",
    });
    expect(openTenantDecision({ logEnd: 41 as never, highWater: 40 as never })).toEqual({
      kind: "serve",
    });
  });

  it("stops on the log's end below the high water", () => {
    expect(openTenantDecision({ logEnd: 39 as never, highWater: 40 as never })).toEqual({
      kind: "not_implemented",
      what: "log_behind_high_water",
    });
  });

  it("checks the import marker first, then the restore marker, then the high water", () => {
    const all = {
      importInProgress: IMPORT,
      restoreInProgress: RESTORE,
      logEnd: 1 as never,
      highWater: 9 as never,
    };
    expect(openTenantDecision(all)).toEqual({
      kind: "not_implemented",
      what: "import_in_progress",
    });
    const { importInProgress: _, ...noImport } = all;
    expect(openTenantDecision(noImport)).toEqual({
      kind: "not_implemented",
      what: "restore_in_progress",
    });
    const { restoreInProgress: __, ...neither } = noImport;
    expect(openTenantDecision(neither)).toEqual({
      kind: "not_implemented",
      what: "log_behind_high_water",
    });
  });
});
