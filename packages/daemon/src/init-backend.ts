// What `init` makes a home's tenant storage with: the product's PgliteBackend, unless a test set
// another through the package's testing entry (testing.fixture.ts). Not exported from index.ts:
// neither the command line, the environment nor the package's types reach it.

import { PgliteBackend } from "@fluxvita/saveslot-store-pglite";

let forTests: PgliteBackend | undefined;

/** The backend `init` makes the tenant storage with. */
export function initBackend(): PgliteBackend {
  return forTests ?? new PgliteBackend();
}

/**
 * Tests only: what `init` makes the home's tenant storage with (`new PgliteBackend()` otherwise);
 * undefined goes back to it. It is this module's state, kept for the rest of the test file: a file
 * that sets it must restore it in afterAll, and a case that unsets it must set it again after.
 */
export function useInitBackendForTests(b: PgliteBackend | undefined): void {
  forTests = b;
}
