// Signing a server profile out (06-cli §2, §4.2): `saveslot logout`. Under the profile's lock: the
// refresh token revoked at the server (RFC 7009), then the credentials file removed, whatever the
// server said. The server side is 05-surfaces §15.
//
// - A file for another server than the profile's is not sent anywhere (06 §2): removed only.
// - A file that is not of the form cannot be revoked: removed only.
// - No file: not signed in, nothing to do.
// - The revocation is made holding the lock, so it ends within LOCKED_REQUEST_MS (06 §2): out of
//   time is `not_revoked`.

import {
  CLI_CLIENT_ID,
  CredentialError,
  LOCKED_REQUEST_MS,
  oauthPost,
  readProfileCredentials,
  removeProfileCredentials,
  withProfileLock,
} from "@fluxvita/saveslot-client";

/**
 * How the sign-out went; the file is gone in every case but `none`.
 * - `revoked`: the server took the revocation.
 * - `not_revoked`: the server could not be reached, or said no.
 * - `other_server`: the file was for another server: nothing was sent.
 * - `malformed`: the file was not of the form: nothing was sent.
 * - `none`: there was no file.
 */
export type SignOutResult = "revoked" | "not_revoked" | "other_server" | "malformed" | "none";

export async function signOut(o: {
  readonly home: string;
  readonly profile: string;
  /** The profile's server, an origin. */
  readonly server: string;
  /** Tests only: the profile lock's wait and staleness, and LOCKED_REQUEST_MS (06 §2's otherwise). */
  readonly testing?: {
    readonly lock?: { readonly waitMs?: number; readonly staleMs?: number };
    readonly lockedRequestMs?: number;
  };
}): Promise<SignOutResult> {
  return withProfileLock(
    o.home,
    o.profile,
    async () => {
      let refresh: string | undefined;
      let result: SignOutResult;
      try {
        const c = await readProfileCredentials(o.home, o.profile);
        if (c === undefined) return "none";
        if (c.server !== o.server) result = "other_server";
        else {
          refresh = c.refresh_token;
          result = "revoked";
        }
      } catch (e) {
        if (!(e instanceof CredentialError) || e.code !== "malformed") throw e;
        result = "malformed";
      }
      if (refresh !== undefined) {
        try {
          await oauthPost({
            server: o.server,
            path: "/oauth/revoke",
            form: new Map([
              ["token", refresh],
              ["token_type_hint", "refresh_token"],
              ["client_id", CLI_CLIENT_ID],
            ]),
            timeoutMs: o.testing?.lockedRequestMs ?? LOCKED_REQUEST_MS,
          });
        } catch {
          result = "not_revoked";
        }
      }
      await removeProfileCredentials(o.home, o.profile);
      return result;
    },
    o.testing?.lock,
  );
}
