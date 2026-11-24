// Test helpers of the PGlite backend for other packages' tests (test-backend): the parameters a
// storage is made from, and the making of its data directory alone, for the test backend's store
// template. Source only (not built), so not part of the published package; only tests and their
// fixtures may import it.

export { createPgdata, creation } from "./backend.ts";
