// The HTTP client of the saveslot contract (02-architecture §11): the credential a client runs with
// (the local session, or a server profile's sign-in), HTTP over the service's unix socket or to a
// server, and the operations as calls on its routes. The contract's types and constant sets are
// passed on: the CLI depends on this package only.

export * from "@fluxvita/saveslot-contract";
export * from "./client.ts";
export * from "./credentials.ts";
export * from "./profile-credentials.ts";
export * from "./profiles.ts";
export * from "./transport.ts";
