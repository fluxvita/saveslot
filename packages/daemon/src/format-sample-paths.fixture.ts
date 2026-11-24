// Where the storage format's samples are kept and which format this version writes. Nothing is
// imported from the packages here: scripts/make-format-sample.ts reads this file under plain Node.

import { resolve } from "node:path";

/**
 * The storage format this version writes (the kernel's CURRENT_FORMAT, which this package
 * does not import): what a sample made now is filed under. The genesis event read from the
 * sample's log says the same, and `expectedOf` checks it.
 */
export const CURRENT_FORMAT = 5;

/** Where the samples are kept, from the repository root. */
export const SAMPLES_DIR = "packages/test-backend/fixtures/storage-format";
export const REPO = resolve(import.meta.dirname, "../../..");
