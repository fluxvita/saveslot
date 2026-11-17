// The client the commands run on, for tests outside this package (the entry package's end-to-end
// tests): exported as `@fluxvita/saveslot-cli/testing` only, so the client is not part of this
// package's interface.

export * from "@fluxvita/saveslot-client";
/** The CLI's static texts, for tests to compare its output with. */
export { TEXTS } from "./texts.ts";
