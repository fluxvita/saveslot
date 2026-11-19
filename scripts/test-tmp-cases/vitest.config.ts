// The configuration of the runs `test-tmp.test.ts` starts to see how a run ends: the cases beside
// this file, with the same global setup as the repository's own run.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/test-tmp-cases/*.case.ts"],
    globalSetup: ["scripts/test-tmp.ts"],
  },
});
