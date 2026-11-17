// The HTTP client of the saveslot contract (02-architecture §11): the credential a local client runs
// with, HTTP over the service's unix socket, and the operations as calls on its routes. The contract's
// types and constant sets are passed on: the CLI depends on this package only.

export * from "@fluxvita/saveslot-contract";
export * from "./client.ts";
export * from "./credentials.ts";
export * from "./transport.ts";
