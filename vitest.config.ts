import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve workspace packages to their TypeScript sources (the "source" export condition),
    // so tests do not depend on a prior build.
    conditions: ["source"],
  },
  // Tests run in the Node (SSR) environment, which has its own resolve conditions.
  ssr: { resolve: { conditions: ["source"], externalConditions: ["source"] } },
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
