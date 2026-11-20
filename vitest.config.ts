import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve workspace packages to their TypeScript sources (the "source" export condition),
    // so tests do not depend on a prior build.
    conditions: ["source"],
  },
  // Tests run in the Node (SSR) environment, which has its own resolve conditions.
  ssr: {
    resolve: { conditions: ["source"], externalConditions: ["source"] },
    // External packages that publish a "source" condition of their own, pointing at TypeScript
    // that Node does not load from node_modules: inlined, so Vite transforms them.
    noExternal: ["@modelcontextprotocol/client", "eventsource"],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts", "evals/tools/**/*.test.ts"],
    // A temporary directory of the run's own, cleared when the run ends (scripts/test-tmp.ts).
    // Then, for a run with a PostgreSQL server: its test databases dropped when it ends.
    globalSetup: ["scripts/test-tmp.ts", "packages/test-backend/src/databases.fixture.ts"],
    // The run's end drops every test database of a run on PostgreSQL, a checkpoint for each group
    // of drops: on a server that syncs to disk that can take more than the 10 s Vitest gives by
    // default, after which it would exit and leave the rest for the next run without a word.
    teardownTimeout: 300_000,
  },
});
