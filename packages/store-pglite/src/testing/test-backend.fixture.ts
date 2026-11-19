// The backend that tests open their stores with: see the test-backend package, where it is made
// (PGlite, or PostgreSQL in its place). Kept here for the files that import it by this path.
//
// By path, not by the package's name: test-backend depends on this package, and naming it in this
// package's devDependencies would make the two a cycle in the workspace.

export { TEST_DURABILITY, testBackend } from "../../../test-backend/src/index.fixture.ts";
