// How a caller's credential came to be, as a call record gives it
// (docs/zh-CN/process/decisions/server-call-records.md §2): never the client ID itself, which is a
// string the client chose (a document URL's path, a dynamically registered client's name), only
// how it was registered and, for a client document, the URL's origin.

import { CLI_CLIENT_ID, CONSOLE_CLIENT_ID } from "./oauth-client.ts";

export interface CallerSource {
  /** `session`: a user session; `token`: an issued connection token; `oauth`: an authorization. */
  readonly via: "session" | "token" | "oauth";
  /** With `oauth`: how its client was registered. */
  readonly registration?: "document" | "dynamic" | "builtin";
  /** With `document`: the client ID's origin (scheme and host); with `builtin`: its fixed name. */
  readonly client?: string;
}

/** A user session's source. */
export const SESSION_SOURCE: CallerSource = { via: "session" };

/** The source of a connection instance, from what its registration recorded (`via`, `client`). */
export function connectionSource(via: string | null, client: string | null): CallerSource {
  if (via !== "oauth") return { via: "token" };
  if (client === null) return { via: "oauth" };
  // Saveslot's own clients. Not reached today: the CLI's and the console's authorizations give
  // user sessions (via `session`), not connection instances; kept for a built-in client that
  // registers one.
  if (client === CLI_CLIENT_ID || client === CONSOLE_CLIENT_ID) {
    return { via: "oauth", registration: "builtin", client };
  }
  // A client document: its ID is an HTTPS URL (`clientIdUrl` takes no other); the origin is what
  // the authorization vouched for.
  // Dynamic registration (RFC 7591) is not in this version: when it is, its client IDs are
  // recognized here (`registration: "dynamic"`, no `client`), by the form that registration gives.
  try {
    const url = new URL(client);
    if (url.protocol === "https:") {
      return { via: "oauth", registration: "document", client: url.origin };
    }
  } catch {
    // Not a URL: none of the forms above.
  }
  return { via: "oauth" };
}
